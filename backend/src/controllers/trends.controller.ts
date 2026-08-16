import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { DateRangeError, parseDateRange } from '../lib/dateRange';

/**
 * Everything that moves, on one shared timeline.
 *
 * The existing reports each answer one question well, and none of them can be
 * drawn as a graph: they return totals and breakdowns, not buckets. A chart
 * needs a spine of periods that all the series agree on, which is what this is.
 *
 * WHY THE PERIODS COME FROM generate_series AND NOT FROM THE DATA.
 *
 * A GROUP BY only produces rows for days something happened. Feed those
 * straight into a line chart and a restaurant that was closed on Monday gets a
 * line drawn from Sunday to Tuesday as though Monday never existed — the
 * timeline silently compresses, and a week with three quiet days looks like a
 * shorter, busier week. Worse for bars: the gaps just vanish and every bar
 * shifts left. So the days are generated first and the figures are LEFT JOINed
 * onto them; a day with no trade is a real zero.
 *
 * WHY ONE QUERY.
 *
 * The series have to line up bucket for bucket. Four separate endpoints, each
 * with its own rounding of the window, is four chances for the revenue line and
 * the waste line to disagree about which day is which.
 */

/** How wide a bucket is. Anything longer than a few months is unreadable daily. */
export const BUCKETS = ['day', 'week', 'month'] as const;
export type Bucket = (typeof BUCKETS)[number];

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return Number(v);
}

/** Percentage of `part` in `whole`, or null when the question is meaningless. */
function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

interface RawPoint {
  bucket_start: Date;
  revenue: unknown;
  costed_revenue: unknown;
  cogs: unknown;
  order_count: number;
  waste_cost: unknown;
  write_off_cost: unknown;
  purchasing_cost: unknown;
}

/**
 * GET /api/reports/trends?days=|from=&to=&bucket=day|week|month
 *
 * FINANCE_ROLES only, by the route. Every figure here is money.
 */
export async function getTrends(req: Request, res: Response): Promise<void> {
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

  const requested = req.query.bucket;
  if (requested !== undefined && !(BUCKETS as readonly unknown[]).includes(requested)) {
    // Refused rather than silently defaulted: a caller asking for months and
    // getting days back would draw a chart labelled with the wrong period.
    res.status(400).json({ error: `bucket must be one of: ${BUCKETS.join(', ')}` });
    return;
  }
  const bucket: Bucket = (requested as Bucket) ?? 'day';

  try {
    const rows = await req.tx.$queryRaw<RawPoint[]>`
      WITH spine AS (
        SELECT generate_series(
                 date_trunc(${bucket}, ${from}::timestamptz),
                 -- One microsecond back from the exclusive end, so a window
                 -- ending at midnight does not generate an empty extra bucket
                 -- for the following day.
                 date_trunc(${bucket}, ${until}::timestamptz - interval '1 microsecond'),
                 CASE ${bucket}::text
                   WHEN 'week' THEN interval '1 week'
                   WHEN 'month' THEN interval '1 month'
                   ELSE interval '1 day'
                 END
               ) AS bucket_start
      ),
      sales AS (
        SELECT date_trunc(${bucket}, o.created_at)                          AS bucket_start,
               COALESCE(SUM(oi.quantity * oi.unit_price), 0)                AS revenue,
               COALESCE(SUM(oi.quantity * oi.unit_price)
                        FILTER (WHERE oi.cost_is_complete), 0)              AS costed_revenue,
               COALESCE(SUM(oi.cost_at_sale)
                        FILTER (WHERE oi.cost_is_complete), 0)              AS cogs
          FROM public.order_items oi
          JOIN public.orders o ON o.id = oi.order_id
         -- Voided sales are not revenue, and counting their cost would
         -- understate margin. Same rule as the profitability report.
         WHERE o.status = 'completed'
           AND o.created_at >= ${from} AND o.created_at < ${until}
         GROUP BY 1
      ),
      tickets AS (
        SELECT date_trunc(${bucket}, o.created_at) AS bucket_start,
               COUNT(*)::int                       AS order_count
          FROM public.orders o
         WHERE o.status = 'completed'
           AND o.created_at >= ${from} AND o.created_at < ${until}
         GROUP BY 1
      ),
      binned AS (
        SELECT date_trunc(${bucket}, w.created_at) AS bucket_start,
               COALESCE(SUM(w.total_cost) FILTER (
                 WHERE w.reason IN ('expired', 'spoiled', 'damaged', 'prep_error')), 0)
                                                    AS waste_cost,
               COALESCE(SUM(w.total_cost), 0)       AS write_off_cost
          FROM public.stock_write_offs w
         WHERE w.created_at >= ${from} AND w.created_at < ${until}
         GROUP BY 1
      ),
      bought AS (
        SELECT date_trunc(${bucket}, po.placed_at)                        AS bucket_start,
               COALESCE(SUM(l.quantity_ordered * l.unit_price), 0)        AS purchasing_cost
          FROM public.purchase_orders po
          JOIN public.purchase_order_lines l ON l.purchase_order_id = po.id
         -- Committed spend, dated when the order was PLACED. A draft is not a
         -- commitment and a cancelled order was never one.
         WHERE po.placed_at IS NOT NULL
           AND po.status IN ('placed', 'received')
           AND po.placed_at >= ${from} AND po.placed_at < ${until}
         GROUP BY 1
      )
      SELECT s.bucket_start,
             COALESCE(sa.revenue, 0)          AS revenue,
             COALESCE(sa.costed_revenue, 0)   AS costed_revenue,
             COALESCE(sa.cogs, 0)             AS cogs,
             COALESCE(t.order_count, 0)       AS order_count,
             COALESCE(b.waste_cost, 0)        AS waste_cost,
             COALESCE(b.write_off_cost, 0)    AS write_off_cost,
             COALESCE(p.purchasing_cost, 0)   AS purchasing_cost
        FROM spine s
        LEFT JOIN sales   sa ON sa.bucket_start = s.bucket_start
        LEFT JOIN tickets t  ON t.bucket_start  = s.bucket_start
        LEFT JOIN binned  b  ON b.bucket_start  = s.bucket_start
        LEFT JOIN bought  p  ON p.bucket_start  = s.bucket_start
       ORDER BY s.bucket_start
    `;

    const points = rows.map((r) => {
      const revenue = num(r.revenue);
      const costedRevenue = num(r.costed_revenue);
      const cogs = num(r.cogs);
      return {
        /** The bucket's first calendar day, as a local date. */
        bucket_start: toLocalDay(r.bucket_start),
        revenue,
        costed_revenue: costedRevenue,
        cogs,
        /** Over COSTED revenue only, so a partly costed period is not flattered. */
        gross_profit: costedRevenue - cogs,
        order_count: r.order_count,
        waste_cost: num(r.waste_cost),
        write_off_cost: num(r.write_off_cost),
        purchasing_cost: num(r.purchasing_cost),
      };
    });

    const sum = (pick: (p: (typeof points)[number]) => number) =>
      points.reduce((total, p) => total + pick(p), 0);

    const revenue = sum((p) => p.revenue);
    const costedRevenue = sum((p) => p.costed_revenue);
    const cogs = sum((p) => p.cogs);
    const grossProfit = costedRevenue - cogs;
    const orders = sum((p) => p.order_count);
    const wasteCost = sum((p) => p.waste_cost);

    res.status(200).json({
      ...range.label,
      bucket,
      summary: {
        revenue,
        costed_revenue: costedRevenue,
        cogs,
        gross_profit: grossProfit,
        margin_pct: pct(grossProfit, costedRevenue),
        /** Share of revenue the margin above actually speaks for. */
        coverage_pct: pct(costedRevenue, revenue),
        order_count: orders,
        /** Null rather than 0 when nothing sold — there was no average ticket. */
        average_ticket: orders > 0 ? Math.round((revenue / orders) * 100) / 100 : null,
        waste_cost: wasteCost,
        write_off_cost: sum((p) => p.write_off_cost),
        /** Waste over total food cost. Null when no food moved at all. */
        waste_share_pct: pct(wasteCost, wasteCost + cogs),
        purchasing_cost: sum((p) => p.purchasing_cost),
        bucket_count: points.length,
      },
      points,
    });
  } catch (err) {
    logger.error('reports.trends failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * A bucket's start as a YYYY-MM-DD calendar date.
 *
 * Deliberately NOT toISOString().slice(0,10): date_trunc returns local midnight,
 * and in any timezone east of UTC that instant is the PREVIOUS day in UTC. The
 * chart would be labelled a day early — for every bucket, consistently enough
 * that nobody would notice it was wrong.
 */
function toLocalDay(value: Date | string): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
