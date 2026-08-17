import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { SAFETY_CAP } from '../lib/pagination';

/**
 * Suppliers, and what they charge.
 *
 * Every stock lot already recorded its cost; attributing lots to a supplier is
 * what turns those numbers into an answerable question — who is getting dearer,
 * and who is cheapest for a given ingredient.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function postgresErrorCode(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as { code?: unknown } | undefined;
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

/** Trims a required text field, or null when it is absent/blank. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * GET /api/suppliers
 *
 * Everyone may read: an accountant reviewing what was paid needs to see who it
 * was paid to. Inactive suppliers are included so historical lots still resolve
 * to a name — the UI filters them out of pickers rather than the API hiding
 * them and leaving old lots showing a blank.
 */
export async function listSuppliers(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  try {
    const suppliers = await req.tx.suppliers.findMany({
      orderBy: [{ is_active: 'desc' }, { name: 'asc' }],
      take: SAFETY_CAP,
    });
    res.status(200).json(suppliers);
  } catch (err) {
    logger.error('suppliers.list failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/suppliers  { name, contact_name?, phone?, notes? }
 *
 * Admin-only: requireRole gates the route and the 0020 require_admin_insert
 * policy is the real backstop.
 */
export async function createSupplier(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = text(body.name);
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const supplier = await req.tx.suppliers.create({
      data: {
        organization_id: orgId,
        name,
        contact_name: text(body.contact_name),
        phone: text(body.phone),
        notes: text(body.notes),
      },
    });
    res.status(201).json(supplier);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23505' || code === 'P2002') {
      // Two records for one supplier would split its price history in half.
      res.status(409).json({ error: 'A supplier with that name already exists' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to manage suppliers' });
      return;
    }
    logger.error('suppliers.create failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/suppliers/:id  { name?, contact_name?, phone?, notes?, is_active? }
 *
 * Renaming, correcting contact details, or retiring a supplier. There is no
 * delete: lots reference suppliers, and that attribution is the record of what
 * past months cost. `is_active: false` removes them from the pickers while
 * every historical lot keeps its name.
 */
export async function updateSupplier(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid supplier id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = text(body.name);
    if (!name) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    data.name = name;
  }
  // These three are nullable, so an explicit null clears them.
  for (const field of ['contact_name', 'phone', 'notes'] as const) {
    if (body[field] !== undefined) {
      data[field] = text(body[field]);
    }
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active must be a boolean' });
      return;
    }
    data.is_active = body.is_active;
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: 'No changes supplied' });
    return;
  }

  try {
    const supplier = await req.tx.suppliers.update({ where: { id }, data });
    res.status(200).json(supplier);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P2025') {
      res.status(404).json({ error: 'Supplier not found' });
      return;
    }
    if (code === '23505' || code === 'P2002') {
      res.status(409).json({ error: 'A supplier with that name already exists' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to manage suppliers' });
      return;
    }
    logger.error('suppliers.update failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/suppliers/price-history
 *
 * What each supplier has charged for each ingredient, and whether that price is
 * moving. One row per (ingredient, supplier).
 *
 * `latest_cost` vs `previous_cost` is the question an owner actually asks —
 * "did they put the price up?" — which a simple average would hide. `min`/`max`
 * bound the range so a single odd delivery is visible as an outlier rather than
 * mistaken for a trend.
 *
 * Only ATTRIBUTED lots appear. A lot with no supplier is not evidence about any
 * supplier, and folding those into an average would smear unattributed history
 * across whoever happens to be listed.
 */
export async function getPriceHistory(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    // COUNT is cast to int: res.json cannot serialize a BigInt.
    const rows = await req.tx.$queryRaw`
      WITH ranked AS (
          SELECT b.raw_item_id,
                 b.supplier_id,
                 b.cost_at_purchase,
                 b.quantity_received,
                 b.received_at,
                 ROW_NUMBER() OVER (PARTITION BY b.raw_item_id, b.supplier_id
                                    ORDER BY b.received_at DESC) AS recency
          FROM public.inventory_batches b
          WHERE b.supplier_id IS NOT NULL
      )
      SELECT r.raw_item_id,
             ri.name                                   AS raw_item_name,
             ri.unit_of_measure,
             r.supplier_id,
             s.name                                    AS supplier_name,
             s.is_active                               AS supplier_is_active,
             COUNT(*)::int                             AS deliveries,
             MAX(r.received_at)                        AS last_delivered_at,
             MIN(r.cost_at_purchase)                   AS min_cost,
             MAX(r.cost_at_purchase)                   AS max_cost,
             MAX(r.cost_at_purchase) FILTER (WHERE r.recency = 1) AS latest_cost,
             MAX(r.cost_at_purchase) FILTER (WHERE r.recency = 2) AS previous_cost,
             SUM(r.quantity_received * r.cost_at_purchase)        AS total_spend
      FROM ranked r
      JOIN public.raw_inventory_items ri ON ri.id = r.raw_item_id
      JOIN public.suppliers s            ON s.id  = r.supplier_id
      GROUP BY r.raw_item_id, ri.name, ri.unit_of_measure,
               r.supplier_id, s.name, s.is_active
      ORDER BY ri.name ASC, s.name ASC
      LIMIT ${SAFETY_CAP}
    `;
    res.status(200).json(rows);
  } catch (err) {
    logger.error('suppliers.priceHistory failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
