import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { parsePage, SAFETY_CAP } from '../lib/pagination';

/**
 * Stocktakes: counting the shelf and making the books agree with it.
 *
 * The loop is create -> count -> post. A draft snapshots what the system
 * believes it has; the manager walks the shelf entering what is actually there;
 * posting hands the variances to app.post_stocktake, which draws lots down or
 * trues them up so on-hand matches the count (0019).
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

/**
 * POST /api/inventory/stocktakes
 *
 * Opens a draft covering every ingredient, each line pre-filled with what the
 * system currently believes is on hand.
 *
 * That snapshot is the whole point of `expected_quantity`: variance is measured
 * against what the books said WHEN THE COUNT STARTED, so a sale rung up midway
 * through the count does not silently become a discrepancy the manager is asked
 * to explain. It also means a draft should be posted promptly — the longer it
 * sits, the more the snapshot ages.
 *
 * Only one draft at a time. Two open counts would race: both snapshot the same
 * expectation, and whichever posts second would apply its variance to stock the
 * first has already corrected.
 */
export async function createStocktake(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    const existing = await req.tx.stocktakes.findFirst({
      where: { organization_id: orgId, status: 'draft' },
      select: { id: true },
    });
    if (existing) {
      res.status(409).json({
        error: 'A stocktake is already open. Post or cancel it before starting another.',
        stocktake_id: existing.id,
      });
      return;
    }

    const stocktake = await req.tx.stocktakes.create({
      data: { organization_id: orgId, status: 'draft' },
      select: { id: true, status: true, created_at: true },
    });

    // One line per ingredient, expected = on hand from OPEN lots. An ingredient
    // with no stock is included at 0 on purpose: "the shelf should be empty" is
    // a claim worth confirming, and it is where found stock most often turns up.
    // counted_quantity defaults to 0, so an unvisited line reads as "counted
    // nothing" — the UI shows every line as needing a number before posting.
    await req.tx.$executeRaw`
      INSERT INTO public.stocktake_items
          (stocktake_id, organization_id, raw_item_id, expected_quantity, counted_quantity)
      SELECT ${stocktake.id}::uuid,
             ${orgId}::uuid,
             ri.id,
             COALESCE(st.on_hand, 0),
             COALESCE(st.on_hand, 0)
      FROM public.raw_inventory_items ri
      LEFT JOIN LATERAL (
          SELECT SUM(b.quantity_remaining) AS on_hand
          FROM public.inventory_batches b
          WHERE b.raw_item_id = ri.id
            AND b.organization_id = ri.organization_id
            AND b.quantity_remaining > 0
      ) st ON true
      WHERE ri.organization_id = ${orgId}::uuid
    `;

    res.status(201).json(stocktake);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to run a stocktake' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[stocktake.create] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/inventory/stocktakes
 *
 * Recent stocktakes, newest first, each with how many lines it covers and how
 * many of those disagreed with the books.
 */
export async function listStocktakes(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const { take, skip } = parsePage(req, { defaultLimit: 50, maxLimit: 200 });
    // COUNT is cast to int: res.json cannot serialize the BigInt a bare count
    // would return.
    const rows = await req.tx.$queryRaw`
      SELECT s.id,
             s.status,
             s.created_at,
             s.updated_at,
             COUNT(si.id)::int                                   AS item_count,
             COUNT(si.id) FILTER (WHERE si.variance <> 0)::int    AS variance_count
      FROM public.stocktakes s
      LEFT JOIN public.stocktake_items si ON si.stocktake_id = s.id
      GROUP BY s.id, s.status, s.created_at, s.updated_at
      ORDER BY s.created_at DESC
      LIMIT ${take} OFFSET ${skip}
    `;
    res.status(200).json(rows);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stocktake.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/inventory/stocktakes/:id
 *
 * One stocktake with its lines, each naming the ingredient and its unit so the
 * count sheet reads without a second request.
 */
export async function getStocktake(req: Request, res: Response): Promise<void> {
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
    // RLS scopes this, so another tenant's stocktake is simply not there.
    const stocktake = await req.tx.stocktakes.findUnique({
      where: { id },
      select: { id: true, status: true, created_at: true, updated_at: true },
    });
    if (!stocktake) {
      res.status(404).json({ error: 'Stocktake not found' });
      return;
    }

    const items = await req.tx.$queryRaw`
      SELECT si.id,
             si.raw_item_id,
             ri.name,
             ri.unit_of_measure,
             si.expected_quantity,
             si.counted_quantity,
             si.variance
      FROM public.stocktake_items si
      JOIN public.raw_inventory_items ri ON ri.id = si.raw_item_id
      WHERE si.stocktake_id = ${id}::uuid
      ORDER BY ri.name ASC
      LIMIT ${SAFETY_CAP}
    `;

    res.status(200).json({ ...stocktake, items });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stocktake.get] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/inventory/stocktakes/:id/items  { counts: [{ raw_item_id, counted_quantity }] }
 *
 * Records what was actually on the shelf. Accepts a batch so a whole count
 * sheet saves in one request rather than one per ingredient.
 *
 * Draft-only, checked here rather than left to the database: stocktake_items
 * has no constraint tying it to its parent's status, so a PATCH against a
 * posted stocktake would otherwise quietly rewrite the record of a count that
 * has already moved stock.
 */
export async function updateStocktakeCounts(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid stocktake id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as { counts?: unknown };
  if (!Array.isArray(body.counts) || body.counts.length === 0) {
    res.status(400).json({ error: 'counts must be a non-empty array' });
    return;
  }

  const counts: Array<{ raw_item_id: string; counted_quantity: number }> = [];
  for (const entry of body.counts) {
    const line = (entry ?? {}) as { raw_item_id?: unknown; counted_quantity?: unknown };
    if (typeof line.raw_item_id !== 'string' || !UUID_RE.test(line.raw_item_id)) {
      res.status(400).json({ error: 'each count needs a valid raw_item_id (uuid)' });
      return;
    }
    if (typeof line.counted_quantity !== 'number' || !Number.isFinite(line.counted_quantity)) {
      res.status(400).json({ error: 'counted_quantity must be a number' });
      return;
    }
    if (line.counted_quantity < 0) {
      // A negative count is not a shortfall, it is a typo.
      res.status(400).json({ error: 'counted_quantity cannot be negative' });
      return;
    }
    counts.push({ raw_item_id: line.raw_item_id, counted_quantity: line.counted_quantity });
  }

  try {
    const stocktake = await req.tx.stocktakes.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!stocktake) {
      res.status(404).json({ error: 'Stocktake not found' });
      return;
    }
    if (stocktake.status !== 'draft') {
      res.status(409).json({ error: `A ${stocktake.status} stocktake can no longer be edited` });
      return;
    }

    let updated = 0;
    for (const line of counts) {
      // updateMany, not update: the target is identified by the (stocktake, raw
      // item) pair rather than a row id the client would have to carry, and a
      // line that is not part of this stocktake simply matches nothing.
      const result = await req.tx.stocktake_items.updateMany({
        where: { stocktake_id: id, raw_item_id: line.raw_item_id },
        data: { counted_quantity: line.counted_quantity },
      });
      updated += result.count;
    }

    res.status(200).json({ status: 'ok', stocktake_id: id, updated });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to run a stocktake' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[stocktake.updateCounts] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/inventory/stocktakes/:id/cancel
 *
 * Abandons a draft without touching stock — the count was started by mistake,
 * or interrupted. 'cancelled' is already an allowed status; nothing could reach
 * it before. Posted stocktakes cannot be cancelled: they have already moved
 * stock, and undoing that is a fresh count, not a status change.
 */
export async function cancelStocktake(req: Request, res: Response): Promise<void> {
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
    const stocktake = await req.tx.stocktakes.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!stocktake) {
      res.status(404).json({ error: 'Stocktake not found' });
      return;
    }
    if (stocktake.status !== 'draft') {
      res.status(409).json({ error: `A ${stocktake.status} stocktake cannot be cancelled` });
      return;
    }

    await req.tx.stocktakes.update({ where: { id }, data: { status: 'cancelled' } });
    res.status(200).json({ status: 'ok', stocktake_id: id });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to run a stocktake' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[stocktake.cancel] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
