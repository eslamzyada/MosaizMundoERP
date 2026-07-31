import { Request, Response } from 'express';
import { DateRangeError, parseDateRange } from '../lib/dateRange';

/**
 * What the restaurant BOUGHT.
 *
 * The one side of the business with no report at all. Sales, waste, stock value
 * and staff each had one; purchasing had a page listing individual orders and
 * nothing that added them up — so "who are we spending the most with" and "what
 * have we committed to that has not turned up yet" were questions the system
 * held the answer to and could not be asked.
 *
 * TWO NUMBERS THAT ARE NOT THE SAME, AND THE DIFFERENCE IS THE POINT.
 *
 *   committed — what was ordered, priced at the agreed unit price
 *   received  — what actually arrived, priced the same way
 *
 * Their difference is money promised to a supplier that is still not on the
 * shelf. Reporting only one of them hides either the exposure or the shortfall,
 * and a partly delivered order is the normal case, not an edge case.
 */

/** Enough suppliers and ingredients to see the whole picture; a guard, not a page. */
const ROW_CAP = 200;

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * GET /api/reports/purchasing?days=|from=&to=
 *
 * FINANCE_ROLES only, by the route.
 *
 * Dated by `placed_at`, not `created_at`: a draft written last month and placed
 * today is this month's spending. Cancelled orders are excluded everywhere —
 * they were never a commitment.
 */
export async function getPurchasing(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  let range;
  try {
    range = parseDateRange(req);
  } catch (err) {
    if (err instanceof DateRangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const { from, until } = range;

  try {
    const bySupplier = await req.tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        is_active: boolean;
        order_count: number;
        committed: unknown;
        received: unknown;
        outstanding: unknown;
      }>
    >`
      SELECT su.id,
             su.name,
             su.is_active,
             COUNT(DISTINCT po.id)::int                             AS order_count,
             COALESCE(SUM(l.quantity_ordered * l.unit_price), 0)    AS committed,
             COALESCE(SUM(l.quantity_received * l.unit_price), 0)   AS received,
             -- GREATEST guards an over-delivery: receiving more than was
             -- ordered is not negative debt, it is simply nothing outstanding.
             COALESCE(SUM(GREATEST(l.quantity_ordered - l.quantity_received, 0)
                          * l.unit_price), 0)                       AS outstanding
        FROM public.purchase_orders po
        JOIN public.suppliers su ON su.id = po.supplier_id
        JOIN public.purchase_order_lines l ON l.purchase_order_id = po.id
       WHERE po.placed_at IS NOT NULL
         AND po.status IN ('placed', 'received')
         AND po.placed_at >= ${from} AND po.placed_at < ${until}
       GROUP BY su.id, su.name, su.is_active
       ORDER BY 5 DESC
       LIMIT ${ROW_CAP}
    `;

    const byStatus = await req.tx.$queryRaw<
      Array<{ status: string; order_count: number; committed: unknown }>
    >`
      SELECT po.status,
             COUNT(DISTINCT po.id)::int                          AS order_count,
             COALESCE(SUM(l.quantity_ordered * l.unit_price), 0) AS committed
        FROM public.purchase_orders po
        LEFT JOIN public.purchase_order_lines l ON l.purchase_order_id = po.id
       -- Every status here, INCLUDING draft and cancelled: this breakdown is
       -- where you find out that half the orders never got placed, which the
       -- spend figures deliberately hide.
       WHERE COALESCE(po.placed_at, po.created_at) >= ${from}
         AND COALESCE(po.placed_at, po.created_at) < ${until}
       GROUP BY po.status
       ORDER BY 3 DESC
    `;

    const byItem = await req.tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        unit_of_measure: string;
        quantity_ordered: unknown;
        committed: unknown;
        last_unit_price: unknown;
      }>
    >`
      SELECT r.id,
             r.name,
             r.unit_of_measure,
             COALESCE(SUM(l.quantity_ordered), 0)                AS quantity_ordered,
             COALESCE(SUM(l.quantity_ordered * l.unit_price), 0) AS committed,
             -- The most recent price agreed in the window, not an average:
             -- what the next delivery will cost is the useful number.
             (ARRAY_AGG(l.unit_price ORDER BY po.placed_at DESC))[1] AS last_unit_price
        FROM public.purchase_orders po
        JOIN public.purchase_order_lines l ON l.purchase_order_id = po.id
        JOIN public.raw_inventory_items r ON r.id = l.raw_item_id
       WHERE po.placed_at IS NOT NULL
         AND po.status IN ('placed', 'received')
         AND po.placed_at >= ${from} AND po.placed_at < ${until}
       GROUP BY r.id, r.name, r.unit_of_measure
       ORDER BY 5 DESC
       LIMIT ${ROW_CAP}
    `;

    // Everything still owed to us, whenever it was ordered. Deliberately NOT
    // limited to the window: an order placed three months ago and never
    // delivered is exactly the one worth chasing, and a window-scoped figure
    // would quietly drop it the moment it aged out.
    const [openNow] = await req.tx.$queryRaw<
      Array<{ order_count: number; outstanding: unknown; oldest_placed_at: Date | null }>
    >`
      SELECT COUNT(DISTINCT po.id)::int AS order_count,
             COALESCE(SUM(GREATEST(l.quantity_ordered - l.quantity_received, 0)
                          * l.unit_price), 0) AS outstanding,
             MIN(po.placed_at)               AS oldest_placed_at
        FROM public.purchase_orders po
        JOIN public.purchase_order_lines l ON l.purchase_order_id = po.id
       WHERE po.status = 'placed'
         AND l.quantity_received < l.quantity_ordered
    `;

    const committed = bySupplier.reduce((s, r) => s + num(r.committed), 0);
    const received = bySupplier.reduce((s, r) => s + num(r.received), 0);

    res.status(200).json({
      ...range.label,
      summary: {
        committed,
        received,
        /** Ordered in this window and not yet delivered. */
        outstanding: bySupplier.reduce((s, r) => s + num(r.outstanding), 0),
        /** How much of what was ordered actually turned up. Null if nothing was. */
        fulfilment_pct: pct(received, committed),
        order_count: bySupplier.reduce((s, r) => s + r.order_count, 0),
        supplier_count: bySupplier.length,
        /** Every undelivered order, regardless of when it was placed. */
        open_orders: {
          order_count: openNow?.order_count ?? 0,
          outstanding: num(openNow?.outstanding),
          oldest_placed_at: openNow?.oldest_placed_at ?? null,
        },
      },
      by_supplier: bySupplier.map((r) => ({
        id: r.id,
        name: r.name,
        is_active: r.is_active,
        order_count: r.order_count,
        committed: num(r.committed),
        received: num(r.received),
        outstanding: num(r.outstanding),
      })),
      by_status: byStatus.map((r) => ({
        status: r.status,
        order_count: r.order_count,
        committed: num(r.committed),
      })),
      by_item: byItem.map((r) => ({
        id: r.id,
        name: r.name,
        unit_of_measure: r.unit_of_measure,
        quantity_ordered: num(r.quantity_ordered),
        committed: num(r.committed),
        last_unit_price: num(r.last_unit_price),
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.purchasing] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
