import { Request, Response } from 'express';
import { cached, contextFor } from '../lib/cache';
import { Prisma } from '@prisma/client';
import { parsePage, SAFETY_CAP } from '../lib/pagination';
import {
  isVoidReason,
  REASON_REQUIRING_NOTE,
  VOID_NOTE_MAX_LENGTH,
  VOID_REASONS,
} from '../lib/voidReasons';

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
 * POST /api/pos/orders/:id/void
 *   { restore_stock: boolean, void_reason: string, void_note?: string }
 *
 * Voids a completed order via app.void_order.
 *
 * restore_stock is REQUIRED and has no default, because only the caller knows
 * which kind of void this is: a mis-tap caught before cooking (the ingredients
 * never moved — restore) or a remake/walk-out (the food was made — the stock is
 * genuinely gone). Guessing either way corrupts inventory half the time.
 *
 * void_reason (0022) is REQUIRED and drawn from a closed vocabulary. A void
 * without a cause is an unreadable event: twenty a week might be a cashier who
 * needs training, a kitchen plating the wrong dish, or two similar burgers next
 * to each other on the button grid, and all three look identical without it.
 * void_note is optional context, and mandatory only for 'other'.
 *
 * The two are deliberately INDEPENDENT — a kitchen error caught at the pass
 * restores stock, a cancellation after plating does not — so nothing here
 * derives one from the other.
 *
 * requireRole gates the route, but the procedure is SECURITY INVOKER and the
 * 0010 orders UPDATE policy is the real boundary. Error contract: P0002 -> 404,
 * 55000 -> 409, 42501 -> 403 (0018); 22023 / 23514 -> 400 (0022).
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

  const body = (req.body ?? {}) as {
    restore_stock?: unknown;
    void_reason?: unknown;
    void_note?: unknown;
  };
  if (typeof body.restore_stock !== 'boolean') {
    res.status(400).json({
      error:
        'restore_stock (boolean) is required: true if the food was never made, false if it was',
    });
    return;
  }

  if (!isVoidReason(body.void_reason)) {
    res.status(400).json({
      error: 'void_reason is required and must be one of the recognised causes',
      allowed: VOID_REASONS,
    });
    return;
  }
  const reason = body.void_reason;

  if (body.void_note !== undefined && body.void_note !== null && typeof body.void_note !== 'string') {
    res.status(400).json({ error: 'void_note must be text' });
    return;
  }
  // Trimmed here as well as in the procedure so the length check below measures
  // the note that will actually be stored, not its whitespace.
  const note = typeof body.void_note === 'string' ? body.void_note.trim() : '';

  if (reason === REASON_REQUIRING_NOTE && note === '') {
    res.status(400).json({
      error: `void_note is required when void_reason is '${REASON_REQUIRING_NOTE}'`,
    });
    return;
  }
  if (note.length > VOID_NOTE_MAX_LENGTH) {
    res.status(400).json({
      error: `void_note must be ${VOID_NOTE_MAX_LENGTH} characters or fewer`,
    });
    return;
  }

  try {
    // Cast explicitly: the note may be NULL, and an untyped NULL parameter
    // leaves Postgres unable to resolve which procedure is being called.
    await req.tx.$executeRaw`CALL app.void_order(
      ${id}::uuid, ${body.restore_stock}, ${reason}::text, ${note === '' ? null : note}::text)`;
    res.status(200).json({
      status: 'ok',
      order_id: id,
      stock_restored: body.restore_stock,
      void_reason: reason,
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
    // The validation above should mean neither of these is reachable. If one
    // is, the API and the schema have drifted apart — answer honestly rather
    // than as a 500, and let voidReasons.drift.test.ts be the thing that stops
    // it happening again.
    if (code === '22023' || code === '23514') {
      res.status(400).json({
        error: 'The void reason was rejected by the database',
        allowed: VOID_REASONS,
      });
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
 *
 * Each line carries its item's NAME, not just the id. A till voiding a mistake
 * has to pick the right order out of a list, and two orders can easily share a
 * total — "3 items, 190.00" is not identification, "برجر لحم x2" is.
 */
export async function getOrders(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const { take, skip } = parsePage(req, { defaultLimit: 100, maxLimit: 200 });
    const orders = await req.tx.orders.findMany({
      include: {
        order_items: {
          include: { sellable_items: { select: { name: true, sku: true } } },
        },
      },
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
 * The caller's catalog, with how many portions of each dish the stock on hand
 * can still make. Runs on req.tx (bound to the RLS session), so it returns ONLY
 * the caller's organization's items — no explicit organization_id filter.
 *
 * `portions_available` is the smallest number of portions any single ingredient
 * allows: one dish needing 200g of chicken and 1 flatbread is limited by
 * whichever runs out first. That is the number a cashier actually needs — not
 * raw stock levels, which would require them to do recipe arithmetic mid-queue.
 *
 * NULL means unconstrained, not zero: an item with no recipe consumes no
 * tracked ingredient, so nothing limits it. Reporting 0 there would grey out
 * every drink and side that has never been given a recipe.
 *
 * ADVISORY ONLY — this must never block a sale, and checkout does not consult
 * it. The POS works offline, so the figure is a snapshot that can be stale by
 * the time it matters; and process_pos_checkout already records a deficit when
 * a sale outruns recorded stock, which is the honest response to selling
 * something the books did not know you had. Blocking on a stale number would
 * refuse real sales at the till, which is far worse than a deficit to reconcile.
 */
export async function getMenu(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    // COUNT/FLOOR are cast to int: res.json cannot serialize a BigInt, and a
    // fractional portion is not a thing a cashier can sell.
    const ctx = await contextFor(req);

    // The menu is cached; `portions_available` inside it is NOT allowed to go
    // stale, and those two facts fight.
    //
    // Availability is derived from stock, and stock moves on every sale, void,
    // write-off, stocktake and delivery — five paths today and a sixth
    // whenever somebody adds one. Sprinkling invalidate() across all of them
    // is the version that silently rots the first time one is missed, and a
    // menu confidently offering three portions of a dish that sold out a
    // minute ago is exactly the "gap that reads as a number" this codebase
    // keeps refusing.
    //
    // So the stock itself is part of the cache NAME. When anything moves, the
    // stamp changes, the key changes, and the old entry is abandoned rather
    // than hunted down — the same trick the plan in cacheKey uses, for the
    // same reason: the event that should invalidate it cannot be relied on to
    // reach this code.
    //
    // The cost is one indexed max() against the cost of the aggregation below.
    const [stamp] = await req.tx.$queryRaw<Array<{ v: string }>>`
      SELECT COALESCE(MAX(b.updated_at), 'epoch')::text || ':' || count(*)::text AS v
        FROM public.inventory_batches b`;

    const items = await cached('pos-menu', ctx, `s=${stamp?.v ?? 'none'}`, 60, async () =>
      req.tx!.$queryRaw`
      WITH stock AS (
          SELECT b.raw_item_id,
                 SUM(b.quantity_remaining) AS on_hand
          FROM public.inventory_batches b
          WHERE b.quantity_remaining > 0
          GROUP BY b.raw_item_id
      ),
      -- Portions each individual ingredient allows, per dish.
      per_ingredient AS (
          SELECT bom.sellable_item_id,
                 FLOOR(COALESCE(st.on_hand, 0) / bom.quantity_required)::int AS portions
          FROM public.bill_of_materials bom
          LEFT JOIN stock st ON st.raw_item_id = bom.raw_item_id
      )
      SELECT s.id,
             s.organization_id,
             s.name,
             s.sku,
             s.price,
             s.created_at,
             s.updated_at,
             -- MIN over an empty set is NULL, which is exactly the "no recipe,
             -- so nothing constrains it" case.
             MIN(p.portions) AS portions_available
      FROM public.sellable_items s
      LEFT JOIN per_ingredient p ON p.sellable_item_id = s.id
      -- Retired dishes leave the till (0035). The row stays for the orders that
      -- already sold it; what changes is that nobody can sell it again.
      WHERE s.is_active
      GROUP BY s.id, s.organization_id, s.name, s.sku, s.price,
               s.created_at, s.updated_at
      ORDER BY s.name ASC
      LIMIT ${SAFETY_CAP}
    `);
    res.status(200).json(items);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pos.menu] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
