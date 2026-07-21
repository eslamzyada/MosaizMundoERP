import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { parsePage, SAFETY_CAP } from '../lib/pagination';

// Pulls the PostgreSQL SQLSTATE out of a Prisma raw-query error, when present.
// A raw CALL that the database rejects surfaces as a PrismaClientKnownRequestError
// whose meta.code is the 5-char SQLSTATE (e.g. 42501 RLS, 23514 CHECK, P0001
// RAISE). Its absence means the failure was not a database rejection.
function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    if (meta && typeof meta.code === 'string') {
      return meta.code;
    }
  }
  return undefined;
}

/**
 * POST /api/pos/checkout
 *
 * Routes the cart to the idempotent app.process_pos_checkout stored procedure.
 * Runs on req.tx — the auth middleware's transaction that already bound
 * app.current_user_id — so the SECURITY INVOKER procedure sees the caller's
 * identity and RLS enforces tenancy (a payload for another org is rejected in
 * the database, not by application-side filtering).
 */
export async function processCheckout(req: Request, res: Response): Promise<void> {
  const checkoutPayload = req.body;

  if (
    checkoutPayload === null ||
    typeof checkoutPayload !== 'object' ||
    Array.isArray(checkoutPayload)
  ) {
    res.status(400).json({ error: 'Request body must be a JSON checkout payload' });
    return;
  }

  if (!req.tx) {
    // The auth middleware always sets req.tx; this guards against a route being
    // mounted without it.
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    // The payload is bound as a parameter and cast to jsonb in-database — never
    // string-concatenated — so there is no injection surface. Idempotent: a
    // retried client_offline_id is a silent no-op in the procedure and still
    // returns 200 here.
    await req.tx.$executeRaw`CALL app.process_pos_checkout(${JSON.stringify(
      checkoutPayload,
    )}::jsonb)`;

    // The procedure INSERTs ... ON CONFLICT DO NOTHING, so it cannot return the
    // id directly. Read it back by the idempotency key — inside the same tx, so
    // this sees the just-inserted (or pre-existing, on retry) row under RLS.
    const { organization_id, client_offline_id } = checkoutPayload as {
      organization_id?: string;
      client_offline_id?: string;
    };
    const order = await req.tx.orders.findFirst({
      where: { organization_id, client_offline_id },
      select: { id: true },
    });

    res
      .status(200)
      .json({ status: 'ok', message: 'Checkout processed', order_id: order?.id ?? null });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pos.checkout] failed:', err);

    const pgCode = postgresErrorCode(err);
    if (pgCode) {
      // The database rejected the request: RLS (42501), a CHECK/FK/UNIQUE
      // violation, a raised exception (P0001), or invalid JSON/UUID. All are
      // the caller's fault — surface the SQLSTATE without the raw DB message.
      res.status(400).json({ error: 'Checkout could not be processed', code: pgCode });
      return;
    }

    res.status(500).json({ error: 'Internal server error' });
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/pos/orders/:id/void  { restore_stock: boolean }
 *
 * Voids a completed order via app.void_order. restore_stock is REQUIRED and has
 * no default, because only the caller knows which kind of void this is: a
 * mis-tap caught before cooking (the ingredients never moved — restore) or a
 * remake/walk-out (the food was made — the stock is genuinely gone). Guessing
 * either way corrupts inventory half the time.
 *
 * requireRole gates the route, but the procedure is SECURITY INVOKER and the
 * 0010 orders UPDATE policy is the real boundary. Error contract from 0018:
 * P0002 -> 404, 55000 -> 409, 42501 -> 403.
 */
export async function voidOrder(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid order id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as { restore_stock?: unknown };
  if (typeof body.restore_stock !== 'boolean') {
    res.status(400).json({
      error:
        'restore_stock (boolean) is required: true if the food was never made, false if it was',
    });
    return;
  }

  try {
    await req.tx.$executeRaw`CALL app.void_order(${id}::uuid, ${body.restore_stock})`;
    res.status(200).json({
      status: 'ok',
      order_id: id,
      stock_restored: body.restore_stock,
    });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P0002') {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    if (code === '55000') {
      res.status(409).json({ error: 'Order is already voided' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Voiding an order is limited to managers' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[pos.voidOrder] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/pos/orders?limit=&offset=
 *
 * Returns the caller's order history (RLS-scoped via req.tx), newest first,
 * with each order's line items nested. Paginated (analysis F-04): order history
 * grows without bound, so a bare findMany would eventually return the entire
 * table — and hold its connection for the whole scan.
 */
export async function getOrders(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const { take, skip } = parsePage(req, { defaultLimit: 100, maxLimit: 200 });
    const orders = await req.tx.orders.findMany({
      include: { order_items: true },
      orderBy: { created_at: 'desc' },
      take,
      skip,
    });
    res.status(200).json(orders);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pos.orders] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/pos/menu
 *
 * Returns the caller's catalog. Because the query runs on req.tx (bound to the
 * RLS session), sellable_items.findMany automatically returns ONLY the items
 * for the caller's organization(s) — no explicit organization_id filter.
 */
export async function getMenu(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const items = await req.tx.sellable_items.findMany({
      orderBy: { name: 'asc' },
      take: SAFETY_CAP,
    });
    res.status(200).json(items);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pos.menu] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
