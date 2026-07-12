import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

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
    const deficits = await req.tx.inventory_deficits.findMany({
      include: {
        raw_inventory_items: {
          select: { id: true, name: true, unit_of_measure: true },
        },
      },
      orderBy: { recorded_at: 'desc' },
    });
    res.status(200).json(deficits);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[inventory.deficits] failed:', err);
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
