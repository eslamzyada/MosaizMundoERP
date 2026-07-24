import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { parsePage, SAFETY_CAP } from '../lib/pagination';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
    // Raw queries ($executeRaw/$queryRaw) carry the Postgres SQLSTATE in
    // meta.code. Typed operations (create/update) instead surface Prisma's own
    // code — P2002 (unique violation), P2025 (record not found).
    if (meta && typeof meta.code === 'string') return meta.code;
    return err.code;
  }
  return undefined;
}

/** The caller's organization: earliest ACTIVE membership — the same rule as GET /api/me. */
async function resolveOrgId(req: Request): Promise<string | null> {
  const membership = await req.tx!.organization_memberships.findFirst({
    where: { user_id: req.userId!, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
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
          ri.is_active,
          COALESCE(SUM(b.quantity_remaining), 0)                      AS on_hand,
          COUNT(b.id)::int                                            AS open_batches,
          MIN(b.expiry_date)                                          AS earliest_expiry,
          COALESCE(SUM(b.quantity_remaining * b.cost_at_purchase), 0) AS stock_value
      FROM public.raw_inventory_items ri
      LEFT JOIN public.inventory_batches b
             ON b.raw_item_id       = ri.id
            AND b.organization_id   = ri.organization_id
            AND b.quantity_remaining > 0
      GROUP BY ri.id, ri.name, ri.unit_of_measure, ri.reorder_threshold, ri.is_active
      -- Retired ingredients drop off once they are empty. While they still hold
      -- stock they stay listed and flagged, because that stock is real and
      -- somebody has to sell, count or write it off.
      HAVING ri.is_active OR COALESCE(SUM(b.quantity_remaining), 0) > 0
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
    total_cost?: unknown;
    expiry_date?: unknown;
    supplier_id?: unknown;
  };

  if (typeof body.raw_item_id !== 'string' || !UUID_RE.test(body.raw_item_id)) {
    res.status(400).json({ error: 'raw_item_id (uuid) is required' });
    return;
  }

  // Attribution is optional (0020): a delivery can be recorded now and
  // attributed later, and found stock has no supplier at all.
  let supplierId: string | null = null;
  if (body.supplier_id !== undefined && body.supplier_id !== null) {
    if (typeof body.supplier_id !== 'string' || !UUID_RE.test(body.supplier_id)) {
      res.status(400).json({ error: 'supplier_id must be a uuid when supplied' });
      return;
    }
    supplierId = body.supplier_id;
  }
  if (typeof body.quantity_received !== 'number' || !(body.quantity_received > 0)) {
    res.status(400).json({ error: 'quantity_received must be a positive number' });
    return;
  }
  /*
   * The cost may be stated either way, because a supplier's invoice states a
   * TOTAL while the lot stores a RATE (currency per unit_of_measure — the FIFO
   * walk multiplies it by the quantity drawn).
   *
   * Whichever arrives, both are recorded: the rate because costing needs it,
   * and the total because it is the fact on the invoice and the only thing a
   * reconciliation can compare against. Deriving the total later from
   * rate x quantity is not the same number once the rate has been rounded,
   * which is exactly the discrepancy worth keeping.
   */
  const hasUnit = typeof body.cost_at_purchase === 'number';
  const hasTotal = typeof body.total_cost === 'number';

  if (hasUnit === hasTotal) {
    res.status(400).json({
      error:
        'Give exactly one of cost_at_purchase (per unit of measure) or total_cost (the invoice total)',
    });
    return;
  }
  if (hasUnit && (body.cost_at_purchase as number) < 0) {
    res.status(400).json({ error: 'cost_at_purchase must be a non-negative number' });
    return;
  }
  if (hasTotal && (body.total_cost as number) < 0) {
    res.status(400).json({ error: 'total_cost must be a non-negative number' });
    return;
  }
  if (
    (hasUnit && !Number.isFinite(body.cost_at_purchase as number)) ||
    (hasTotal && !Number.isFinite(body.total_cost as number))
  ) {
    res.status(400).json({ error: 'The cost must be a finite number' });
    return;
  }

  const quantity = body.quantity_received as number;
  // Six decimals, matching the column: a per-gram rate is a fraction of a
  // piastre, and rounding it here would put the loss back that 0025 removed.
  const unitCost = hasUnit
    ? (body.cost_at_purchase as number)
    : Math.round(((body.total_cost as number) / quantity) * 1e6) / 1e6;
  // Two decimals: this one IS a currency amount.
  const totalCost = hasTotal
    ? (body.total_cost as number)
    : Math.round((body.cost_at_purchase as number) * quantity * 100) / 100;

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
        cost_at_purchase: unitCost,
        total_cost: totalCost,
        expiry_date: expiry,
        // The composite FK (supplier_id, organization_id) refuses a supplier
        // from another tenant, so this needs no separate ownership check —
        // it surfaces below as a foreign key violation.
        supplier_id: supplierId,
      },
    });

    res.status(201).json(batch);
  } catch (err) {
    const pgCode = postgresErrorCode(err);
    // The composite supplier FK is the only foreign key this insert can break
    // that the caller controls: the raw item was already resolved under RLS.
    if (pgCode === '23503' || pgCode === 'P2003') {
      res.status(400).json({ error: 'Supplier not found in this organization' });
      return;
    }
    if (pgCode) {
      // eslint-disable-next-line no-console
      console.error('[inventory.receive] failed:', err);
      res.status(400).json({ error: 'Could not receive stock', code: pgCode });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[inventory.receive] failed:', err);
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

/**
 * POST /api/inventory/items  { name, unit_of_measure, reorder_threshold? }
 *
 * Creates a raw ingredient in the caller's org. Admin-only: requireRole gates
 * the route and the 0010 RESTRICTIVE require_admin_insert policy is the real
 * backstop. Ingredients are the prerequisite for receiving stock and for
 * recipe (BOM) lines.
 */
export async function createRawItem(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as {
    name?: unknown;
    unit_of_measure?: unknown;
    reorder_threshold?: unknown;
    is_active?: unknown;
  };

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (typeof body.unit_of_measure !== 'string' || body.unit_of_measure.trim().length === 0) {
    res.status(400).json({ error: 'unit_of_measure is required' });
    return;
  }
  let threshold = 0;
  if (body.reorder_threshold !== undefined && body.reorder_threshold !== null) {
    if (typeof body.reorder_threshold !== 'number' || !(body.reorder_threshold >= 0)) {
      res.status(400).json({ error: 'reorder_threshold must be a number >= 0' });
      return;
    }
    threshold = body.reorder_threshold;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const item = await req.tx.raw_inventory_items.create({
      data: {
        organization_id: orgId,
        name: body.name.trim(),
        unit_of_measure: body.unit_of_measure.trim(),
        reorder_threshold: threshold,
      },
    });

    res.status(201).json(item);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23505' || code === 'P2002') {
      res.status(409).json({ error: 'An ingredient with that name already exists' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to manage ingredients' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[inventory.createRawItem] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/inventory/items/:id  { name?, unit_of_measure?, reorder_threshold? }
 *
 * Updates a raw ingredient (rename, change unit, adjust reorder threshold).
 * Admin-only. RLS scopes the update to the caller's org, so a foreign id
 * resolves as not-found (404).
 */
export async function updateRawItem(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid ingredient id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as {
    name?: unknown;
    unit_of_measure?: unknown;
    reorder_threshold?: unknown;
    is_active?: unknown;
  };
  const data: {
    name?: string;
    unit_of_measure?: string;
    reorder_threshold?: number;
    is_active?: boolean;
  } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    data.name = body.name.trim();
  }
  if (body.unit_of_measure !== undefined) {
    if (typeof body.unit_of_measure !== 'string' || body.unit_of_measure.trim().length === 0) {
      res.status(400).json({ error: 'unit_of_measure must be a non-empty string' });
      return;
    }
    data.unit_of_measure = body.unit_of_measure.trim();
  }
  // Archiving (0024). An ingredient with history cannot be deleted — the
  // foreign keys refuse it, deliberately, since cascading would erase recorded
  // COGS and the consumption ledger. Retiring it is this flag: gone from every
  // picker, still counted wherever it holds stock, still in every past record.
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active must be true or false' });
      return;
    }
    data.is_active = body.is_active;
  }
  if (body.reorder_threshold !== undefined) {
    if (typeof body.reorder_threshold !== 'number' || !(body.reorder_threshold >= 0)) {
      res.status(400).json({ error: 'reorder_threshold must be a number >= 0' });
      return;
    }
    data.reorder_threshold = body.reorder_threshold;
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'Provide at least one of: name, unit_of_measure, reorder_threshold' });
    return;
  }

  try {
    const item = await req.tx.raw_inventory_items.update({ where: { id }, data });
    res.status(200).json(item);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P2025') {
      res.status(404).json({ error: 'Ingredient not found' });
      return;
    }
    if (code === '23505' || code === 'P2002') {
      res.status(409).json({ error: 'An ingredient with that name already exists' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to manage ingredients' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[inventory.updateRawItem] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
