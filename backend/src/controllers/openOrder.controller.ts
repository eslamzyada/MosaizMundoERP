import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Open orders — the tab a table runs while it is still eating (0029).
 *
 * Every operation here is a thin wrapper over a SECURITY DEFINER function. That
 * is deliberate and it shapes this file: the procedures own the tenant check,
 * the role check, the state machine and the stock arithmetic, so a handler that
 * added its own rules would be adding a second, weaker copy of them. What these
 * handlers own is the HTTP contract — turning a SQLSTATE into a status code.
 *
 *   P0002  the order is not there, or belongs to another organization. 404 for
 *          both, because distinguishing them lets a caller probe ids across
 *          tenants — the procedures answer identically on purpose.
 *   42501  the caller's role may not serve tables.
 *   55000  the order is in the wrong state: already settled, nothing waiting to
 *          be sent, or something unsent still on the bill. 409, not 400 — the
 *          request was well formed, the world just is not ready for it.
 *   22023  a required argument was missing or malformed.
 *   23514  a CHECK rejected it (a note too long for a kitchen ticket).
 *   P0001  a bare RAISE: an item that is not on this menu, a quantity <= 0.
 *
 * Everything runs on req.tx, the auth middleware's transaction with
 * app.current_user_id already bound. A handler using the global client instead
 * would run with no identity: RLS would see no user and the DEFINER functions
 * would refuse it.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * The one place a database refusal becomes an HTTP answer. Returns true when it
 * has responded, so callers read as `if (respondToDbError(...)) return;`.
 *
 * An unrecognised SQLSTATE is a 500 and gets logged: it means the database
 * refused for a reason this contract does not describe, and reporting that as a
 * 400 would blame the caller for a bug on our side.
 */
function respondToDbError(err: unknown, res: Response, context: string): boolean {
  const code = postgresErrorCode(err);

  switch (code) {
    case 'P0002':
      res.status(404).json({ error: 'Order not found' });
      return true;
    case '42501':
      res.status(403).json({ error: 'Serving an order is limited to sales roles' });
      return true;
    case '55000':
      res.status(409).json({ error: messageFor55000(err), code });
      return true;
    case '22023':
    case '23514':
    case 'P0001':
      res.status(400).json({ error: messageFor55000(err), code });
      return true;
    default:
      // eslint-disable-next-line no-console
      console.error(`[${context}] failed:`, err);
      res.status(500).json({ error: 'Internal server error' });
      return true;
  }
}

/**
 * The database's own wording, when it is safe to pass on.
 *
 * These particular messages are written for the person at the till — "3 item(s)
 * have not been sent to the kitchen; send or remove them before settling" is the
 * whole answer, and re-deriving it here would mean maintaining it twice. They
 * are raised by our procedures, never by Postgres internals: the SQLSTATEs that
 * reach this function are only the ones our own RAISE statements produce.
 */
function messageFor55000(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { message?: unknown } | undefined;
    if (meta && typeof meta.message === 'string' && meta.message.trim() !== '') {
      return meta.message;
    }
  }
  return 'The order is not in a state that allows this';
}

function requireTx(req: Request, res: Response): boolean {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return false;
  }
  return true;
}

function requireUuid(value: unknown, res: Response, what: string): value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    res.status(400).json({ error: `A valid ${what} (uuid) is required` });
    return false;
  }
  return true;
}

/**
 * POST /api/pos/orders/open
 *   { organization_id, client_offline_id, table_id?, note?, items?: [...] }
 *
 * Opens a tab. `items` is OPTIONAL: a table is seated and given menus before it
 * orders anything, and an empty tab is the honest record of that.
 *
 * `table_id` is optional too, and stays that way (0045). Takeaway has no
 * table, and a restaurant that does not run the `reservations` module has no
 * floor plan to choose from — for them a tab is what it always was. When it IS
 * given, app.open_order refuses a table that is another restaurant's (400) or
 * one already running a tab (409, naming the table).
 *
 * Idempotent on client_offline_id exactly as checkout is — the till may be
 * offline and retrying, and a retry must not open a second tab for one table.
 * That makes this a 200 rather than a 201: a retry returns the same order, and
 * claiming "Created" on the second call would be a lie.
 */
export async function openOrder(req: Request, res: Response): Promise<void> {
  if (!requireTx(req, res)) return;

  const payload: unknown = req.body;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    res.status(400).json({ error: 'Request body must be a JSON order payload' });
    return;
  }

  try {
    // Bound as a parameter and cast in-database, never concatenated.
    const rows = await req.tx!.$queryRaw<{ order_id: string }[]>`
      SELECT app.open_order(${JSON.stringify(payload)}::jsonb) AS order_id`;

    res.status(200).json({ status: 'ok', order_id: rows[0]?.order_id ?? null });
  } catch (err) {
    respondToDbError(err, res, 'pos.openOrder');
  }
}

/**
 * GET /api/pos/orders/open
 *
 * Every tab currently running, oldest first — a table that has been waiting
 * longest is the one a server needs to look at, so newest-first (the ordering
 * every other list here uses) would bury it.
 *
 * RLS-scoped through req.tx, so no organization filter appears below; adding one
 * would imply the isolation lives in this query rather than in the policy.
 *
 * Each line reports fired_at, because "sent to the kitchen" is the only thing
 * that distinguishes a line a server may still delete from one they may not.
 */
export async function listOpenOrders(req: Request, res: Response): Promise<void> {
  if (!requireTx(req, res)) return;

  try {
    const orders = await req.tx!.orders.findMany({
      where: { status: 'open' },
      include: {
        order_items: {
          include: { sellable_items: { select: { name: true, sku: true } } },
          orderBy: { created_at: 'asc' },
        },
        // The table's LABEL, not just its id (0045). A till showing a uuid is
        // a till nobody can use, and the alternative — a second request per
        // tab to resolve names — is a request per table on a busy floor.
        restaurant_tables: { select: { id: true, label: true, area: true } },
      },
      orderBy: { created_at: 'asc' },
    });
    res.status(200).json(orders);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pos.listOpenOrders] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/pos/orders/:id/items
 *   { items: [{ sellable_item_id, quantity, note? }] }
 *
 * Adds a course to a running tab. The lines land UNFIRED — ordering a dish and
 * telling the kitchen to cook it are two different acts, and merging them would
 * deduct stock for food nobody has started.
 *
 * Prices are not accepted from the client; the procedure reads them from the
 * catalogue (0012).
 */
export async function addOrderItems(req: Request, res: Response): Promise<void> {
  if (!requireTx(req, res)) return;

  const id = req.params.id;
  if (!requireUuid(id, res, 'order id')) return;

  const items = (req.body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items must be a non-empty array' });
    return;
  }

  try {
    const rows = await req.tx!.$queryRaw<{ added: number }[]>`
      SELECT app.add_order_items(${id}::uuid, ${JSON.stringify(items)}::jsonb) AS added`;

    // The new total is read in a SEPARATE statement, deliberately. Selecting it
    // alongside the call above returns the total from BEFORE the insert: every
    // subquery in one statement sees that statement's snapshot, so it cannot
    // observe an UPDATE the same statement is still making. It returned a
    // stale total that way until an end-to-end run caught it.
    const order = await req.tx!.orders.findUnique({
      where: { id },
      select: { total_amount: true },
    });

    res.status(200).json({
      status: 'ok',
      added: Number(rows[0]?.added ?? 0),
      total_amount: order?.total_amount ?? null,
    });
  } catch (err) {
    respondToDbError(err, res, 'pos.addOrderItems');
  }
}

/**
 * DELETE /api/pos/orders/items/:itemId
 *
 * Removes a line the kitchen has not been told about. A FIRED line is refused
 * with 409: the food exists, its ingredients are gone, and taking it off the
 * bill is voiding — which asks whether it was made and what to do about the
 * stock. A quiet delete would destroy that history.
 *
 * The route is deliberately not nested under an order id. The line id alone
 * identifies the line, and accepting an order id here would invite a caller to
 * pass a mismatched pair for the handler to adjudicate.
 */
export async function removeOrderItem(req: Request, res: Response): Promise<void> {
  if (!requireTx(req, res)) return;

  const itemId = req.params.itemId;
  if (!requireUuid(itemId, res, 'line id')) return;

  try {
    // $executeRaw, not $queryRaw: this function RETURNS void, and Prisma cannot
    // deserialize a void column — it fails the whole call with P2010 after the
    // delete has already happened, which is the worst of both worlds (a 500
    // reporting failure for work that succeeded). $executeRaw asks only for a
    // row count and never inspects the column type.
    await req.tx!.$executeRaw`SELECT app.remove_order_item(${itemId}::uuid)`;
    res.status(204).send();
  } catch (err) {
    respondToDbError(err, res, 'pos.removeOrderItem');
  }
}

/**
 * POST /api/pos/orders/:id/fire
 *
 * Sends everything unfired to the kitchen. THIS is where stock moves and cost is
 * captured — the ingredients leave the shelf when the food is cooked, not when
 * the bill is paid.
 *
 * Refuses (409) when nothing is waiting, rather than succeeding quietly: a
 * server who presses "send" twice should be told the kitchen already has it.
 */
export async function fireOrder(req: Request, res: Response): Promise<void> {
  if (!requireTx(req, res)) return;

  const id = req.params.id;
  if (!requireUuid(id, res, 'order id')) return;

  try {
    const rows = await req.tx!.$queryRaw<{ fired: number }[]>`
      SELECT app.fire_order(${id}::uuid) AS fired`;
    res.status(200).json({ status: 'ok', fired: Number(rows[0]?.fired ?? 0) });
  } catch (err) {
    respondToDbError(err, res, 'pos.fireOrder');
  }
}

/**
 * POST /api/pos/orders/:id/settle
 *
 * The tab becomes a sale. Only here does it start counting as revenue — an open
 * order is invisible to every takings figure, which is the whole point of the
 * state.
 *
 * Refused (409) while anything is unfired: those items were never cooked, so
 * settling would either charge for food that does not exist or silently drop it
 * from the bill, and only the person at the till knows which was meant.
 */
export async function settleOrder(req: Request, res: Response): Promise<void> {
  if (!requireTx(req, res)) return;

  const id = req.params.id;
  if (!requireUuid(id, res, 'order id')) return;

  try {
    const rows = await req.tx!.$queryRaw<{ total: Prisma.Decimal }[]>`
      SELECT app.settle_order(${id}::uuid) AS total`;
    res.status(200).json({ status: 'ok', total_amount: rows[0]?.total ?? null });
  } catch (err) {
    respondToDbError(err, res, 'pos.settleOrder');
  }
}
