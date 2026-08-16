import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { parsePage, SAFETY_CAP } from '../lib/pagination';

/**
 * Purchase orders: what has been ordered, and what has actually turned up.
 *
 * The gap between quantity_ordered and quantity_received on each line IS the
 * outstanding position — a gap that never closes is a short delivery, which
 * before 0021 left no trace anywhere.
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

async function resolveOrgId(req: Request): Promise<string | null> {
  const membership = await req.tx!.organization_memberships.findFirst({
    where: { user_id: req.userId!, is_active: true },
    orderBy: { created_at: 'asc' },
    select: { organization_id: true },
  });
  return membership?.organization_id ?? null;
}

interface ParsedLine {
  raw_item_id: string;
  quantity_ordered: number;
  unit_price: number;
}

/** Validates the lines of an order, or returns the message explaining why not. */
function parseLines(raw: unknown): { lines: ParsedLine[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'lines must be a non-empty array' };
  }
  const lines: ParsedLine[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const line = (entry ?? {}) as Record<string, unknown>;
    if (typeof line.raw_item_id !== 'string' || !UUID_RE.test(line.raw_item_id)) {
      return { error: 'each line needs a valid raw_item_id (uuid)' };
    }
    // The DB unique would catch this, but a clear message beats a constraint name.
    if (seen.has(line.raw_item_id)) {
      return { error: 'each ingredient may appear only once on an order' };
    }
    seen.add(line.raw_item_id);
    if (typeof line.quantity_ordered !== 'number' || !(line.quantity_ordered > 0)) {
      return { error: 'quantity_ordered must be a positive number' };
    }
    if (typeof line.unit_price !== 'number' || !(line.unit_price >= 0)) {
      return { error: 'unit_price must be a number >= 0' };
    }
    lines.push({
      raw_item_id: line.raw_item_id,
      quantity_ordered: line.quantity_ordered,
      unit_price: line.unit_price,
    });
  }
  return { lines };
}

/**
 * POST /api/purchase-orders  { supplier_id, expected_at?, notes?, lines[] }
 *
 * Raises a DRAFT. Drafts are not commitments — nothing can be received against
 * one until it is placed, which is what makes "outstanding" mean something.
 */
export async function createPurchaseOrder(req: Request, res: Response): Promise<void> {
  if (!req.tx || !req.userId) {
    res.status(500).json({ error: 'No authenticated transaction on request' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.supplier_id !== 'string' || !UUID_RE.test(body.supplier_id)) {
    res.status(400).json({ error: 'supplier_id (uuid) is required' });
    return;
  }

  let expectedAt: Date | null = null;
  if (body.expected_at !== undefined && body.expected_at !== null) {
    const parsed = new Date(body.expected_at as string);
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'expected_at must be a valid date' });
      return;
    }
    expectedAt = parsed;
  }

  const parsed = parseLines(body.lines);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const orgId = await resolveOrgId(req);
    if (!orgId) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }

    // Header and lines are created separately rather than with a nested create:
    // purchase_order_lines relates to its parent on (purchase_order_id,
    // organization_id), and nesting makes Prisma treat the header's
    // organization_id as owned by that relation, so it cannot be set directly.
    // Both statements share req.tx, so the order and its lines still land
    // atomically — a failure on the lines rolls the header back with it.
    const order = await req.tx.purchase_orders.create({
      data: {
        organization_id: orgId,
        supplier_id: body.supplier_id,
        expected_at: expectedAt,
        notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
      },
    });

    // The composite FKs on the lines refuse an ingredient from another tenant,
    // so no separate ownership check is needed here.
    await req.tx.purchase_order_lines.createMany({
      data: parsed.lines.map((l) => ({
        purchase_order_id: order.id,
        organization_id: orgId,
        raw_item_id: l.raw_item_id,
        quantity_ordered: l.quantity_ordered,
        unit_price: l.unit_price,
      })),
    });

    const lines = await req.tx.purchase_order_lines.findMany({
      where: { purchase_order_id: order.id },
    });

    res.status(201).json({ ...order, purchase_order_lines: lines });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '23503' || code === 'P2003') {
      res.status(400).json({ error: 'Supplier or ingredient not found in this organization' });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to raise purchase orders' });
      return;
    }
    logger.error('purchaseOrders.create failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/purchase-orders/suggestions
 *
 * What has fallen below its reorder threshold, and who to buy it from.
 *
 * The threshold has existed since 0009 and the inventory dashboard has flagged
 * breaches ever since, but nothing connected that signal to the purchasing side
 * — so noticing you were low and actually ordering were separate manual acts.
 *
 * Two things make this trustworthy rather than merely convenient:
 *
 *  * STOCK ALREADY ON ORDER IS NETTED OFF. An ingredient sitting below its
 *    threshold with a delivery already inbound does not need ordering again;
 *    suggesting it would cause double-ordering, which is worse than no
 *    suggestion at all. `quantity_on_order` sums what outstanding PLACED orders
 *    still owe, and `shortfall` is what remains needed after that.
 *  * A SUPPLIER IS ONLY SUGGESTED WHEN THERE IS EVIDENCE. The cheapest ACTIVE
 *    supplier by their most recent price for that exact ingredient — never a
 *    guess, and null when nothing has been bought from anyone yet, so the UI
 *    asks rather than inventing a choice.
 *
 * Deliberately NOT suggested: how much to order beyond the shortfall. That is a
 * par-level decision this system has no data for, and a fabricated multiplier
 * would look authoritative while being arbitrary.
 */
export async function getReorderSuggestions(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const rows = await req.tx.$queryRaw`
      WITH on_hand AS (
          SELECT ri.id,
                 ri.name,
                 ri.unit_of_measure,
                 ri.reorder_threshold,
                 COALESCE(SUM(b.quantity_remaining) FILTER (WHERE b.quantity_remaining > 0), 0)
                   AS quantity_on_hand
          FROM public.raw_inventory_items ri
          LEFT JOIN public.inventory_batches b ON b.raw_item_id = ri.id
          -- Retired ingredients are never suggested (0024): proposing a
          -- purchase order for something deliberately taken out of use is the
          -- clearest possible sign the suggestion engine is not to be trusted.
          WHERE ri.is_active
          GROUP BY ri.id, ri.name, ri.unit_of_measure, ri.reorder_threshold
      ),
      -- What placed orders still owe. Netting this off is what stops a second
      -- order being suggested for stock that is already inbound.
      inbound AS (
          SELECT l.raw_item_id,
                 SUM(l.quantity_ordered - l.quantity_received) AS quantity_on_order
          FROM public.purchase_order_lines l
          JOIN public.purchase_orders o ON o.id = l.purchase_order_id
          WHERE o.status = 'placed'
            AND l.quantity_received < l.quantity_ordered
          GROUP BY l.raw_item_id
      ),
      -- The most recent price each active supplier charged for each ingredient.
      latest_price AS (
          SELECT DISTINCT ON (b.raw_item_id, b.supplier_id)
                 b.raw_item_id,
                 b.supplier_id,
                 s.name AS supplier_name,
                 b.cost_at_purchase,
                 b.received_at
          FROM public.inventory_batches b
          JOIN public.suppliers s ON s.id = b.supplier_id
          WHERE b.supplier_id IS NOT NULL
            AND s.is_active
          ORDER BY b.raw_item_id, b.supplier_id, b.received_at DESC
      ),
      cheapest AS (
          SELECT DISTINCT ON (raw_item_id)
                 raw_item_id, supplier_id, supplier_name, cost_at_purchase
          FROM latest_price
          ORDER BY raw_item_id, cost_at_purchase ASC, supplier_name ASC
      )
      SELECT h.id                                   AS raw_item_id,
             h.name,
             h.unit_of_measure,
             h.quantity_on_hand,
             h.reorder_threshold,
             COALESCE(i.quantity_on_order, 0)       AS quantity_on_order,
             h.reorder_threshold - h.quantity_on_hand - COALESCE(i.quantity_on_order, 0)
                                                    AS shortfall,
             c.supplier_id                          AS suggested_supplier_id,
             c.supplier_name                        AS suggested_supplier_name,
             c.cost_at_purchase                     AS suggested_unit_price
      FROM on_hand h
      LEFT JOIN inbound i  ON i.raw_item_id = h.id
      LEFT JOIN cheapest c ON c.raw_item_id = h.id
      -- A zero threshold means the owner has not asked to be warned about this
      -- ingredient, so it is not a reorder signal.
      WHERE h.reorder_threshold > 0
        AND h.reorder_threshold - h.quantity_on_hand - COALESCE(i.quantity_on_order, 0) > 0
      ORDER BY h.name ASC
      LIMIT ${SAFETY_CAP}
    `;
    res.status(200).json(rows);
  } catch (err) {
    logger.error('purchaseOrders.suggestions failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/purchase-orders?status=
 *
 * Newest first, each with its supplier and how much is still owed. The
 * outstanding total is computed in the database rather than by summing lines in
 * the client, so the list and the detail view cannot disagree.
 */
export async function listPurchaseOrders(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const status = typeof req.query.status === 'string' ? req.query.status : null;
  if (status && !['draft', 'placed', 'received', 'cancelled'].includes(status)) {
    res.status(400).json({ error: 'status must be draft, placed, received or cancelled' });
    return;
  }

  try {
    const { take, skip } = parsePage(req, { defaultLimit: 50, maxLimit: 200 });
    const rows = await req.tx.$queryRaw`
      SELECT o.id,
             o.status,
             o.expected_at,
             o.placed_at,
             o.notes,
             o.created_at,
             o.supplier_id,
             s.name                                            AS supplier_name,
             COUNT(l.id)::int                                  AS line_count,
             COUNT(l.id) FILTER (
               WHERE l.quantity_received < l.quantity_ordered
             )::int                                            AS outstanding_lines,
             COALESCE(SUM(l.quantity_ordered * l.unit_price), 0) AS order_value
      FROM public.purchase_orders o
      JOIN public.suppliers s ON s.id = o.supplier_id
      LEFT JOIN public.purchase_order_lines l ON l.purchase_order_id = o.id
      WHERE (${status}::text IS NULL OR o.status = ${status}::text)
      GROUP BY o.id, o.status, o.expected_at, o.placed_at, o.notes,
               o.created_at, o.supplier_id, s.name
      ORDER BY o.created_at DESC
      LIMIT ${take} OFFSET ${skip}
    `;
    res.status(200).json(rows);
  } catch (err) {
    logger.error('purchaseOrders.list failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/purchase-orders/:id
 *
 * One order with its lines, each naming the ingredient and what is still owed
 * on it — the number a receiving clerk is actually checking against.
 */
export async function getPurchaseOrder(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid purchase order id (uuid) is required' });
    return;
  }

  try {
    // RLS scopes this, so another tenant's order is simply not there.
    const order = await req.tx.purchase_orders.findUnique({
      where: { id },
      include: { suppliers: { select: { id: true, name: true } } },
    });
    if (!order) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    const lines = await req.tx.$queryRaw`
      SELECT l.id,
             l.raw_item_id,
             ri.name             AS raw_item_name,
             ri.unit_of_measure,
             l.quantity_ordered,
             l.quantity_received,
             l.quantity_ordered - l.quantity_received AS quantity_outstanding,
             l.unit_price
      FROM public.purchase_order_lines l
      JOIN public.raw_inventory_items ri ON ri.id = l.raw_item_id
      WHERE l.purchase_order_id = ${id}::uuid
      ORDER BY ri.name ASC
      LIMIT ${SAFETY_CAP}
    `;

    res.status(200).json({ ...order, lines });
  } catch (err) {
    logger.error('purchaseOrders.get failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** draft -> placed. Only then can anything be received against it. */
export async function placePurchaseOrder(req: Request, res: Response): Promise<void> {
  await transition(req, res, {
    from: 'draft',
    to: 'placed',
    stamp: true,
    refusal: (status) => `A ${status} purchase order cannot be placed`,
  });
}

/**
 * draft|placed -> cancelled.
 *
 * Stock already received against the order is NOT unwound: it is physically in
 * the building, and pretending otherwise would corrupt inventory to tidy a
 * status.
 */
export async function cancelPurchaseOrder(req: Request, res: Response): Promise<void> {
  await transition(req, res, {
    from: ['draft', 'placed'],
    to: 'cancelled',
    stamp: false,
    refusal: (status) => `A ${status} purchase order cannot be cancelled`,
  });
}

async function transition(
  req: Request,
  res: Response,
  opts: {
    from: string | string[];
    to: string;
    stamp: boolean;
    refusal: (status: string) => string;
  },
): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid purchase order id (uuid) is required' });
    return;
  }

  const allowed = Array.isArray(opts.from) ? opts.from : [opts.from];

  try {
    const order = await req.tx.purchase_orders.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }
    if (!allowed.includes(order.status)) {
      res.status(409).json({ error: opts.refusal(order.status) });
      return;
    }

    const updated = await req.tx.purchase_orders.update({
      where: { id },
      data: { status: opts.to, ...(opts.stamp ? { placed_at: new Date() } : {}) },
    });
    res.status(200).json(updated);
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to manage purchase orders' });
      return;
    }
    logger.error('purchaseOrders.transition failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/purchase-orders/:id/receive
 *   { receipts: [{ line_id, quantity, unit_cost?, expiry_date? }] }
 *
 * Records a delivery. Each receipt goes through app.receive_purchase_order_line,
 * which creates the stock lot, adds to the line's received total and closes the
 * order when nothing is owed — atomically, under the same per-ingredient lock
 * a sale takes.
 *
 * `unit_cost` is optional and defaults to the agreed price. It exists because
 * the invoice often differs from the quote, and that difference is exactly what
 * the supplier price history is for.
 */
export async function receivePurchaseOrder(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const id = req.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    res.status(400).json({ error: 'A valid purchase order id (uuid) is required' });
    return;
  }

  const body = (req.body ?? {}) as { receipts?: unknown };
  if (!Array.isArray(body.receipts) || body.receipts.length === 0) {
    res.status(400).json({ error: 'receipts must be a non-empty array' });
    return;
  }

  const receipts: Array<{
    line_id: string;
    quantity: number;
    unit_cost: number | null;
    expiry_date: Date | null;
  }> = [];

  for (const entry of body.receipts) {
    const r = (entry ?? {}) as Record<string, unknown>;
    if (typeof r.line_id !== 'string' || !UUID_RE.test(r.line_id)) {
      res.status(400).json({ error: 'each receipt needs a valid line_id (uuid)' });
      return;
    }
    if (typeof r.quantity !== 'number' || !(r.quantity > 0)) {
      res.status(400).json({ error: 'quantity must be a positive number' });
      return;
    }
    let unitCost: number | null = null;
    if (r.unit_cost !== undefined && r.unit_cost !== null) {
      if (typeof r.unit_cost !== 'number' || !(r.unit_cost >= 0)) {
        res.status(400).json({ error: 'unit_cost must be a number >= 0 when supplied' });
        return;
      }
      unitCost = r.unit_cost;
    }
    let expiry: Date | null = null;
    if (r.expiry_date !== undefined && r.expiry_date !== null) {
      const parsed = new Date(r.expiry_date as string);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: 'expiry_date must be a valid date' });
        return;
      }
      expiry = parsed;
    }
    receipts.push({ line_id: r.line_id, quantity: r.quantity, unit_cost: unitCost, expiry_date: expiry });
  }

  try {
    const order = await req.tx.purchase_orders.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!order) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    // Every receipt shares the request's transaction, so a failure part-way
    // through rolls the whole delivery back rather than leaving some lines
    // credited and others not.
    for (const r of receipts) {
      await req.tx.$executeRaw`
        CALL app.receive_purchase_order_line(
          ${r.line_id}::uuid, ${r.quantity}::numeric,
          ${r.unit_cost}::numeric, ${r.expiry_date}::timestamptz)`;
    }

    const updated = await req.tx.purchase_orders.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    res.status(200).json({ status: 'ok', purchase_order: updated });
  } catch (err) {
    const code = postgresErrorCode(err);
    if (code === 'P0002') {
      res.status(404).json({ error: 'Purchase order line not found' });
      return;
    }
    if (code === '55000') {
      res.status(409).json({
        error: 'Only a placed purchase order can take delivery',
      });
      return;
    }
    if (code === '42501') {
      res.status(403).json({ error: 'Your role is not permitted to receive deliveries' });
      return;
    }
    logger.error('purchaseOrders.receive failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
