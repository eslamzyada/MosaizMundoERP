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
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.profitability] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
