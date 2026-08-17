import { logger } from '../lib/logger';
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
    return err.code;
  }
  return undefined;
}

/**
 * Everything that would stop an ingredient being deleted, counted.
 *
 * The foreign keys already decide whether a delete is possible; this only
 * explains the refusal. "You cannot delete this" is a dead end — "3 recipes, 40
 * stock lots and 128 sales reference it" tells someone what they are actually
 * being protected from, and points at archiving as the real answer.
 */
async function referenceCounts(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<
    Array<{
      recipes: bigint;
      lots: bigint;
      consumption: bigint;
      write_offs: bigint;
      stocktakes: bigint;
      purchase_lines: bigint;
      deficits: bigint;
    }>
  >`
    SELECT
      (SELECT count(*) FROM public.bill_of_materials      WHERE raw_item_id = ${id}::uuid) AS recipes,
      (SELECT count(*) FROM public.inventory_batches      WHERE raw_item_id = ${id}::uuid) AS lots,
      (SELECT count(*) FROM public.inventory_consumption  WHERE raw_item_id = ${id}::uuid) AS consumption,
      (SELECT count(*) FROM public.stock_write_offs       WHERE raw_item_id = ${id}::uuid) AS write_offs,
      (SELECT count(*) FROM public.stocktake_items        WHERE raw_item_id = ${id}::uuid) AS stocktakes,
      (SELECT count(*) FROM public.purchase_order_lines   WHERE raw_item_id = ${id}::uuid) AS purchase_lines,
      (SELECT count(*) FROM public.inventory_deficits     WHERE raw_item_id = ${id}::uuid) AS deficits
  `;
  return {
    recipes: Number(row.recipes),
    stock_lots: Number(row.lots),
    consumption_records: Number(row.consumption),
    write_offs: Number(row.write_offs),
    stocktake_counts: Number(row.stocktakes),
    purchase_order_lines: Number(row.purchase_lines),
    deficits: Number(row.deficits),
  };
}

/**
 * DELETE /api/inventory/items/:id
 *
 * Deletes an ingredient that has never been used, and refuses one that has.
 *
 * The rule is not re-implemented here: all seven foreign keys pointing at
 * raw_inventory_items are ON DELETE NO ACTION, so the database already knows
 * the answer and cannot disagree with a check written alongside it. We attempt
 * the delete and translate the refusal — which also makes it race-free, since a
 * "is this used?" query followed by a delete could be overtaken by a sale
 * landing in between.
 *
 * Cascading was never an option: it would erase recorded COGS, the consumption
 * ledger a food-safety recall depends on, and past stocktakes — silently
 * changing profit figures that were reported months ago. An ingredient with
 * history gets archived instead (PATCH is_active), which is what the 409 says.
 */
export async function deleteRawItem(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid ingredient id (uuid) is required' });
    return;
  }

  // A SAVEPOINT, because the whole request runs inside ONE interactive
  // transaction (the RLS contract) and a failed statement poisons it: Postgres
  // aborts the transaction and refuses every subsequent command with 25P02.
  // Without this, the reference counts below — the entire point of the 409 —
  // cannot be gathered after the delete fails, and the request hangs.
  //
  // Rolling back to the savepoint restores a usable transaction while keeping
  // the delete-then-translate approach, which is what makes the check race-free:
  // asking "is this used?" first could be overtaken by a sale landing in between.
  await req.tx.$executeRawUnsafe('SAVEPOINT delete_raw_item');

  try {
    await req.tx.raw_inventory_items.delete({ where: { id } });
    await req.tx.$executeRawUnsafe('RELEASE SAVEPOINT delete_raw_item');
    res.status(204).send();
  } catch (err) {
    await req.tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT delete_raw_item');
    const code = postgresErrorCode(err);

    // Not there, or filtered out by RLS, or the RESTRICTIVE delete policy
    // removed the row from this caller's view — indistinguishable on purpose,
    // so ids cannot be probed across tenants. requireRole already turned the
    // role case into a 403 before reaching here.
    if (code === 'P2025') {
      res.status(404).json({ error: 'Ingredient not found' });
      return;
    }

    if (code === '23503' || code === 'P2003') {
      const references = await referenceCounts(req.tx, id);
      res.status(409).json({
        error:
          'This ingredient has history and cannot be deleted. Archive it instead — ' +
          'it will disappear from every picker while its records stay intact.',
        can_archive: true,
        references,
      });
      return;
    }

    logger.error('inventory.deleteRawItem failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/inventory/batches/:id/cost  { cost_at_purchase }
 *
 * Corrects a cost keyed in wrongly when stock was received — 130.00 instead of
 * 13.00 otherwise poisons stock value, reorder economics and every supplier
 * price comparison, permanently.
 *
 * Routed through app.correct_batch_cost rather than a plain update, because
 * inventory_batches carries require_sell_update (checkout has to decrement
 * quantity_remaining as a cashier) and a bare UPDATE of the cost would
 * therefore be permitted for a cashier by the database itself.
 *
 * Returns both the old and new cost: a correction whose before-and-after the
 * user cannot see is one they have to take on trust. Recorded COGS on past
 * sales is deliberately untouched (0015), so no margin already reported moves.
 */
export async function correctBatchCost(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid stock lot id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as { cost_at_purchase?: unknown };
  const cost = body.cost_at_purchase;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    res.status(400).json({ error: 'cost_at_purchase must be a number of zero or more' });
    return;
  }

  try {
    const rows = await req.tx.$queryRaw<Array<{ previous: unknown }>>`
      SELECT app.correct_batch_cost(${id}::uuid, ${cost}::numeric) AS previous`;

    res.status(200).json({
      status: 'ok',
      batch_id: id,
      previous_cost: Number(rows[0]?.previous),
      cost_at_purchase: cost,
      /** Said out loud because it is the whole reason a correction is safe. */
      note: 'Recorded cost of goods sold on past sales is unchanged.',
    });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P0002') {
      res.status(404).json({ error: 'Stock lot not found' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Correcting a stock cost is limited to managers' });
      return;
    }
    if (code === '22023' || code === '23514') {
      res.status(400).json({ error: 'That cost was rejected by the database' });
      return;
    }
    logger.error('inventory.correctBatchCost failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/inventory/items/:id/batches
 *
 * The open lots behind one ingredient, newest first — what the admin needs in
 * order to point at the lot whose cost was mis-keyed. Aggregated stock hides
 * the individual lots, and a cost belongs to a lot, not to an ingredient.
 */
export async function listItemBatches(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid ingredient id (uuid) is required' });
    return;
  }

  try {
    const batches = await req.tx.$queryRaw`
      SELECT b.id,
             b.quantity_received,
             b.quantity_remaining,
             b.cost_at_purchase,
             b.total_cost,
             -- What the lot's own arithmetic says it cost, so the two can be
             -- compared. A gap means the rate was rounded — which is precisely
             -- what a reconciliation against the supplier is looking for.
             (b.quantity_received * b.cost_at_purchase)::numeric(12, 2) AS implied_total,
             (b.quantity_remaining * b.cost_at_purchase) AS value_remaining,
             b.expiry_date,
             b.received_at,
             s.name AS supplier_name
      FROM public.inventory_batches b
      LEFT JOIN public.suppliers s ON s.id = b.supplier_id
      WHERE b.raw_item_id = ${id}::uuid
      ORDER BY b.received_at DESC
      LIMIT 200
    `;
    res.status(200).json(batches);
  } catch (err) {
    logger.error('inventory.listItemBatches failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
