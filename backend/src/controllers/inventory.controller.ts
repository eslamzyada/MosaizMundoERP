import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { parsePage, SAFETY_CAP } from '../lib/pagination';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * GET /api/inventory/deficits
 *
 * Returns the deficit ledger for the caller's organization(s). Runs on req.tx,
 * so RLS scopes the rows automatically. The raw_inventory_items relation is
 * included so each row carries the missing ingredient's name.
 */
export async function getDeficits(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const { take, skip } = parsePage(req, { defaultLimit: 100, maxLimit: 200 });
    const deficits = await req.tx.inventory_deficits.findMany({
      include: {
        raw_inventory_items: {
          select: { id: true, name: true, unit_of_measure: true },
        },
      },
      orderBy: { recorded_at: 'desc' },
      take,
      skip,
    });
    res.status(200).json(deficits);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[inventory.deficits] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/inventory/items
 *
 * The raw ingredient catalog for the caller's organization (RLS-scoped via
 * req.tx). Powers the recipe editor's "add ingredient" picker.
 */
export async function getRawItems(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const items = await req.tx.raw_inventory_items.findMany({
      orderBy: { name: 'asc' },
      take: SAFETY_CAP,
    });
    res.status(200).json(items);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[inventory.items] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/inventory/stock
 *
 * Stock on hand per raw ingredient — the aggregate of every open FIFO lot, plus
 * the reorder threshold to compare it against, the soonest expiry among open
 * lots, and the value still sitting on the shelf. This is the question the
 * inventory dashboard exists to answer ("what do I actually have?").
 *
 * Aggregated in SQL rather than in JS: the batch table is the hot one and this
 * avoids shipping every lot to the client. Runs on req.tx, so RLS scopes BOTH
 * sides of the join — the composite (raw_item_id, organization_id) join makes a
 * cross-tenant match impossible even before RLS weighs in.
 *
 * Items with no open lots still appear (LEFT JOIN -> on_hand 0), which is
 * exactly the row an operator most needs to see.
 */
export async function getStock(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    // COUNT is cast to int: res.json cannot serialize the BigInt that a bare
    // count() would return (Decimals are handled by the app-level interceptor).
    const stock = await req.tx.$queryRaw`
      SELECT
          ri.id,
          ri.name,
          ri.unit_of_measure,
          ri.reorder_threshold,
          COALESCE(SUM(b.quantity_remaining), 0)                      AS on_hand,
          COUNT(b.id)::int                                            AS open_batches,
          MIN(b.expiry_date)                                          AS earliest_expiry,
          COALESCE(SUM(b.quantity_remaining * b.cost_at_purchase), 0) AS stock_value
      FROM public.raw_inventory_items ri
      LEFT JOIN public.inventory_batches b
             ON b.raw_item_id       = ri.id
            AND b.organization_id   = ri.organization_id
            AND b.quantity_remaining > 0
      GROUP BY ri.id, ri.name, ri.unit_of_measure, ri.reorder_threshold
      ORDER BY ri.name ASC
      LIMIT ${SAFETY_CAP}
    `;
    res.status(200).json(stock);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[inventory.stock] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/inventory/receive
 *
 * Records a new FIFO stock lot. The organization is derived from the raw item
 * itself: raw_inventory_items.findUnique runs under RLS, so the item resolves
 * only if it belongs to the caller's org. That both guarantees the composite
 * FK (raw_item_id, organization_id) is consistent and makes it impossible to
 * inject stock into another tenant (a foreign item is simply invisible -> 404).
 */
export async function receiveStock(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as {
    raw_item_id?: unknown;
    quantity_received?: unknown;
    cost_at_purchase?: unknown;
    expiry_date?: unknown;
  };

  if (typeof body.raw_item_id !== 'string' || !UUID_RE.test(body.raw_item_id)) {
    res.status(400).json({ error: 'raw_item_id (uuid) is required' });
    return;
  }
  if (typeof body.quantity_received !== 'number' || !(body.quantity_received > 0)) {
    res.status(400).json({ error: 'quantity_received must be a positive number' });
    return;
  }
  if (typeof body.cost_at_purchase !== 'number' || body.cost_at_purchase < 0) {
    res.status(400).json({ error: 'cost_at_purchase must be a non-negative number' });
    return;
  }

  let expiry: Date | null = null;
  if (body.expiry_date !== undefined && body.expiry_date !== null) {
    const parsed = new Date(body.expiry_date as string);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'expiry_date must be a valid date' });
      return;
    }
    expiry = parsed;
  }

  try {
    const rawItem = await req.tx.raw_inventory_items.findUnique({
      where: { id: body.raw_item_id },
      select: { organization_id: true },
    });
    if (!rawItem) {
      res.status(404).json({ error: 'Raw item not found' });
      return;
    }

    const batch = await req.tx.inventory_batches.create({
      data: {
        raw_item_id: body.raw_item_id,
        organization_id: rawItem.organization_id,
        quantity_received: body.quantity_received,
        // A fresh lot starts fully available.
        quantity_remaining: body.quantity_received,
        cost_at_purchase: body.cost_at_purchase,
        expiry_date: expiry,
      },
    });

    res.status(201).json(batch);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[inventory.receive] failed:', err);
    const pgCode = postgresErrorCode(err);
    if (pgCode) {
      res.status(400).json({ error: 'Could not receive stock', code: pgCode });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/inventory/stocktakes/:id/post
 *
 * Posts a draft stocktake through the app.post_stocktake procedure, which takes
 * the per-item advisory locks and reconciles variances into deficits / true-up
 * lots. Runs on req.tx so RLS scopes the stocktake to the caller's org (a
 * foreign or non-draft stocktake is rejected in the database -> 400).
 */
export async function postStocktake(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid stocktake id (uuid) is required' });
    return;
  }

  try {
    await req.tx.$executeRaw`CALL app.post_stocktake(${id}::uuid)`;
    res.status(200).json({ status: 'ok', stocktake_id: id, message: 'Stocktake posted' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[inventory.postStocktake] failed:', err);
    // Not-found, not-draft, and RLS rejections all surface as database errors —
    // they are caller errors, so map them to 400.
    const pgCode = postgresErrorCode(err);
    if (pgCode) {
      res.status(400).json({ error: 'Could not post stocktake', code: pgCode });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}
