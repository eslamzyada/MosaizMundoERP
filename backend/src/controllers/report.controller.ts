import { Request, Response } from 'express';

/**
 * Profitability reporting, read from the cost captured at each sale (0015)
 * rather than from today's stock prices. That is the whole point: this answers
 * "what did we actually make", and the answer does not change when the next
 * delivery arrives at a different price.
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
/** Enough dishes to see the whole menu; a guard, not a page size. */
const ITEM_CAP = 200;

/** A window in days: positive, whole, and bounded. */
function parseDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(Math.floor(n), MAX_DAYS);
}

/** Raw aggregates arrive as Decimal (or null when a FILTER matched nothing). */
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

/** Percentage of `part` in `whole`, or null when the question is meaningless. */
function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

interface Bucket {
  revenue: unknown;
  costed_revenue: unknown;
  cogs: unknown;
  uncosted_lines: number;
}

/** The shared shape: money in, money out, and how much of it we can vouch for. */
function summarise(row: Bucket) {
  const revenue = num(row.revenue);
  const costedRevenue = num(row.costed_revenue);
  const cogs = num(row.cogs);
  const grossProfit = costedRevenue - cogs;

  return {
    revenue,
    /** Revenue on lines whose cost is fully known — the only revenue margin is computed over. */
    costed_revenue: costedRevenue,
    cogs,
    gross_profit: grossProfit,
    /** Margin over COSTED revenue, so a partly costed period is not flattered. */
    margin_pct: pct(grossProfit, costedRevenue),
    /** Revenue we cannot cost: an ingredient ran short, or the dish has no recipe. */
    uncosted_revenue: revenue - costedRevenue,
    uncosted_line_count: row.uncosted_lines,
    /** Share of revenue the margin above actually speaks for. */
    coverage_pct: pct(costedRevenue, revenue),
  };
}

/**
 * GET /api/reports/profitability?days=30
 *
 * Revenue, cost of goods sold and gross margin over a window, broken down by
 * day and by menu item. Runs on req.tx, so RLS scopes every figure to the
 * caller's organization. Restricted to FINANCE_ROLES by the route.
 *
 * Two deliberate choices:
 *
 *  * Voided orders are excluded everywhere. A voided sale is not revenue, and
 *    counting its cost would understate margin.
 *  * Margin is computed over FULLY COSTED lines only, and the response reports
 *    how much revenue that leaves out (uncosted_revenue / coverage_pct).
 *    Folding uncosted lines in at cost 0 would inflate the margin exactly when
 *    the data is weakest — a dish sold while its ingredient was out of stock
 *    would look like the most profitable thing on the menu.
 */
export async function getProfitability(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const days = parseDays(req.query.days);

  try {
    // FILTER yields NULL when nothing matches, so every aggregate is coalesced;
    // COUNT is cast to int because res.json cannot serialize a BigInt.
    const daily = await req.tx.$queryRaw<Array<Bucket & { day: Date }>>`
      SELECT
          o.created_at::date                                              AS day,
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)                   AS revenue,
          COALESCE(SUM(oi.quantity * oi.unit_price)
                   FILTER (WHERE oi.cost_is_complete), 0)                 AS costed_revenue,
          COALESCE(SUM(oi.cost_at_sale)
                   FILTER (WHERE oi.cost_is_complete), 0)                 AS cogs,
          COUNT(*) FILTER (WHERE NOT oi.cost_is_complete)::int            AS uncosted_lines
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.status = 'completed'
        AND o.created_at >= now() - make_interval(days => ${days}::int)
      GROUP BY 1
      ORDER BY 1
    `;

    const byItem = await req.tx.$queryRaw<
      Array<Bucket & { id: string; name: string; sku: string | null; units_sold: number }>
    >`
      SELECT
          s.id,
          s.name,
          s.sku,
          COALESCE(SUM(oi.quantity), 0)::int                              AS units_sold,
          COALESCE(SUM(oi.quantity * oi.unit_price), 0)                   AS revenue,
          COALESCE(SUM(oi.quantity * oi.unit_price)
                   FILTER (WHERE oi.cost_is_complete), 0)                 AS costed_revenue,
          COALESCE(SUM(oi.cost_at_sale)
                   FILTER (WHERE oi.cost_is_complete), 0)                 AS cogs,
          COUNT(*) FILTER (WHERE NOT oi.cost_is_complete)::int            AS uncosted_lines
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      JOIN public.sellable_items s ON s.id = oi.sellable_item_id
      WHERE o.status = 'completed'
        AND o.created_at >= now() - make_interval(days => ${days}::int)
      GROUP BY s.id, s.name, s.sku
      ORDER BY 5 DESC
      LIMIT ${ITEM_CAP}
    `;

    // Why any revenue could not be costed — a fix-list, not just a warning.
    //
    // The historical reason is not recorded on the line (only that its cost was
    // incomplete), and it is not the useful question anyway. What an owner needs
    // is what is blocking costing NOW: a dish with no recipe, or a recipe whose
    // ingredients have no stock to price them from. So the blockers are read
    // from current state, and a dish whose blocker has since been fixed is
    // reported as such rather than left on the list forever.
    const gaps = await req.tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        sku: string | null;
        uncosted_lines: number;
        uncosted_revenue: unknown;
        recipe_line_count: number;
        blocking: unknown;
      }>
    >`
      WITH uncosted AS (
          SELECT oi.sellable_item_id,
                 COUNT(*)::int                          AS uncosted_lines,
                 SUM(oi.quantity * oi.unit_price)       AS uncosted_revenue
          FROM public.order_items oi
          JOIN public.orders o ON o.id = oi.order_id
          WHERE o.status = 'completed'
            AND o.created_at >= now() - make_interval(days => ${days}::int)
            AND NOT oi.cost_is_complete
          GROUP BY oi.sellable_item_id
      )
      SELECT
          s.id,
          s.name,
          s.sku,
          u.uncosted_lines,
          u.uncosted_revenue,
          COUNT(bom.id)::int AS recipe_line_count,
          COALESCE(
            jsonb_agg(DISTINCT jsonb_build_object(
                'id',              r.id,
                'name',            r.name,
                'unit_of_measure', r.unit_of_measure
            )) FILTER (WHERE r.id IS NOT NULL AND COALESCE(st.on_hand, 0) <= 0),
            '[]'::jsonb
          ) AS blocking
      FROM uncosted u
      JOIN public.sellable_items s ON s.id = u.sellable_item_id
      LEFT JOIN public.bill_of_materials bom
             ON bom.sellable_item_id = s.id
            AND bom.organization_id  = s.organization_id
      LEFT JOIN public.raw_inventory_items r ON r.id = bom.raw_item_id
      LEFT JOIN LATERAL (
          SELECT SUM(b.quantity_remaining) AS on_hand
          FROM public.inventory_batches b
          WHERE b.raw_item_id = r.id AND b.quantity_remaining > 0
      ) st ON true
      GROUP BY s.id, s.name, s.sku, u.uncosted_lines, u.uncosted_revenue
      ORDER BY u.uncosted_revenue DESC
      LIMIT ${ITEM_CAP}
    `;

    // The window total is summed from the daily buckets rather than queried
    // again, so the headline can never disagree with the chart under it.
    const totals = daily.reduce<Bucket>(
      (acc, d) => ({
        revenue: num(acc.revenue) + num(d.revenue),
        costed_revenue: num(acc.costed_revenue) + num(d.costed_revenue),
        cogs: num(acc.cogs) + num(d.cogs),
        uncosted_lines: acc.uncosted_lines + d.uncosted_lines,
      }),
      { revenue: 0, costed_revenue: 0, cogs: 0, uncosted_lines: 0 },
    );

    res.status(200).json({
      days,
      summary: summarise(totals),
      by_day: daily.map((d) => ({
        // Date only: the bucket is a calendar day, not an instant.
        day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day),
        ...summarise(d),
      })),
      by_item: byItem.map((i) => ({
        id: i.id,
        name: i.name,
        sku: i.sku,
        units_sold: i.units_sold,
        ...summarise(i),
      })),
      coverage_gaps: gaps.map((g) => {
        const blocking = Array.isArray(g.blocking)
          ? (g.blocking as Array<{ id: string; name: string; unit_of_measure: string }>)
          : [];

        return {
          id: g.id,
          name: g.name,
          sku: g.sku,
          uncosted_line_count: g.uncosted_lines,
          uncosted_revenue: num(g.uncosted_revenue),
          blocking_ingredients: blocking,
          // What to do about it, in the order the fixes actually apply:
          //   no_recipe            -> the dish has no bill of materials at all
          //   unstocked_ingredients-> it has one, but some ingredient has no
          //                           stock to price it from
          //   already_resolved     -> neither is true any more; the block was
          //                           fixed after these sales, so future ones
          //                           will be costed and there is nothing to do
          reason:
            g.recipe_line_count === 0
              ? 'no_recipe'
              : blocking.length > 0
                ? 'unstocked_ingredients'
                : 'already_resolved',
        };
      }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.profitability] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
