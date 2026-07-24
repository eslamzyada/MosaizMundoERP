import { Request, Response } from 'express';
import { DateRangeError, parseDateRange } from '../lib/dateRange';

/**
 * Profitability reporting, read from the cost captured at each sale (0015)
 * rather than from today's stock prices. That is the whole point: this answers
 * "what did we actually make", and the answer does not change when the next
 * delivery arrives at a different price.
 */

/** Enough dishes to see the whole menu; a guard, not a page size. */
const ITEM_CAP = 200;

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
 * GET /api/reports/profitability?from=&to=  (or ?days=30)
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

  let range;
  try {
    range = parseDateRange(req);
  } catch (err) {
    if (err instanceof DateRangeError) {
      // A window the caller can fix. Substituting a different one silently
      // would hand back figures for a period they did not ask about.
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const { from, until } = range;

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
        AND o.created_at >= ${from} AND o.created_at < ${until}
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
        AND o.created_at >= ${from} AND o.created_at < ${until}
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
            AND o.created_at >= ${from} AND o.created_at < ${until}
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
      ...range.label,
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

/**
 * GET /api/reports/voids?from=&to=  (or ?days=30)
 *
 * What voiding is costing, grouped by cause (0022). Runs on req.tx, so RLS
 * scopes it to the caller's organization. Restricted to FINANCE_ROLES.
 *
 * A void has two costs and they are not the same money:
 *
 *  * lost_revenue — the order value that will not be collected. Real, but often
 *    recoverable: a mis-tap gets re-rung a moment later and the customer still
 *    pays. Counting it as pure loss would overstate the damage.
 *  * ingredient_cost_lost — the COGS of voids where the stock was NOT restored.
 *    This is food that was made and cannot be sold, and it is the number that
 *    is genuinely gone. It is summed from cost_at_sale (0015), the cost captured
 *    at the moment of the sale, so it does not drift when the next delivery
 *    arrives at a different price.
 *
 * Reporting both, split, is the point. A month of wrong_item voids that all
 * restored their stock costs almost nothing and means "fix the button layout";
 * the same count of kitchen_error voids that did not means the kitchen is
 * throwing away food.
 *
 * `uncosted_void_count` is the honesty column: voids whose COGS is not fully
 * known, so ingredient_cost_lost is a floor rather than a total.
 */
export async function getVoids(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  let range;
  try {
    range = parseDateRange(req);
  } catch (err) {
    if (err instanceof DateRangeError) {
      // A window the caller can fix. Substituting a different one silently
      // would hand back figures for a period they did not ask about.
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const { from, until } = range;

  try {
    // Aggregated per order first: an order has many lines, and summing
    // total_amount across a join to order_items would multiply each order's
    // value by its line count.
    const byReason = await req.tx.$queryRaw<
      Array<{
        void_reason: string;
        void_count: number;
        lost_revenue: unknown;
        stock_returned_count: number;
        ingredient_cost_lost: unknown;
        uncosted_void_count: number;
      }>
    >`
      WITH voided AS (
          SELECT o.id,
                 o.void_reason,
                 o.total_amount,
                 o.stock_restored,
                 COALESCE(SUM(oi.cost_at_sale), 0)          AS cogs,
                 -- An order is fully costed only if every line is. bool_and
                 -- over no rows is NULL, hence the coalesce: an order with no
                 -- lines cannot be vouched for either.
                 COALESCE(bool_and(oi.cost_is_complete), false) AS fully_costed
          FROM public.orders o
          LEFT JOIN public.order_items oi ON oi.order_id = o.id
          WHERE o.status = 'voided'
            AND o.voided_at >= ${from} AND o.voided_at < ${until}
          GROUP BY o.id, o.void_reason, o.total_amount, o.stock_restored
      )
      SELECT
          void_reason,
          COUNT(*)::int                                                  AS void_count,
          COALESCE(SUM(total_amount), 0)                                 AS lost_revenue,
          COUNT(*) FILTER (WHERE stock_restored)::int                    AS stock_returned_count,
          -- Only the un-restored voids destroyed anything.
          COALESCE(SUM(cogs) FILTER (WHERE NOT stock_restored), 0)       AS ingredient_cost_lost,
          COUNT(*) FILTER (WHERE NOT stock_restored
                             AND NOT fully_costed)::int                  AS uncosted_void_count
      FROM voided
      GROUP BY void_reason
      ORDER BY 2 DESC
    `;

    // Who is voiding, which is a different question from why. Deliberately not
    // presented as a leaderboard: a manager who covers the busiest shift will
    // authorise the most corrections, and that is the job, not a red flag. It
    // is here so a real outlier can be noticed at all.
    const byActor = await req.tx.$queryRaw<
      Array<{ user_id: string | null; email: string | null; void_count: number }>
    >`
      SELECT o.voided_by                AS user_id,
             u.email,
             COUNT(*)::int              AS void_count
      FROM public.orders o
      LEFT JOIN public.users u ON u.id = o.voided_by
      WHERE o.status = 'voided'
        AND o.voided_at >= ${from} AND o.voided_at < ${until}
      GROUP BY o.voided_by, u.email
      ORDER BY 3 DESC
      LIMIT ${ITEM_CAP}
    `;

    const rows = byReason.map((r) => ({
      reason: r.void_reason,
      void_count: r.void_count,
      lost_revenue: num(r.lost_revenue),
      /** Voids that put the ingredients back — the cheap kind. */
      stock_returned_count: r.stock_returned_count,
      /** COGS of food that was made and then written off. */
      ingredient_cost_lost: num(r.ingredient_cost_lost),
      /** How many of those the figure above cannot fully account for. */
      uncosted_void_count: r.uncosted_void_count,
    }));

    // Totals summed from the same rows the caller sees, so the headline cannot
    // disagree with the breakdown under it.
    const summary = rows.reduce(
      (acc, r) => ({
        void_count: acc.void_count + r.void_count,
        lost_revenue: acc.lost_revenue + r.lost_revenue,
        stock_returned_count: acc.stock_returned_count + r.stock_returned_count,
        ingredient_cost_lost: acc.ingredient_cost_lost + r.ingredient_cost_lost,
        uncosted_void_count: acc.uncosted_void_count + r.uncosted_void_count,
      }),
      {
        void_count: 0,
        lost_revenue: 0,
        stock_returned_count: 0,
        ingredient_cost_lost: 0,
        uncosted_void_count: 0,
      },
    );

    res.status(200).json({
      ...range.label,
      summary,
      by_reason: rows,
      by_actor: byActor.map((a) => ({
        user_id: a.user_id,
        email: a.email,
        void_count: a.void_count,
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.voids] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/reports/waste?from=&to=  (or ?days=30)
 *
 * What the bin is costing, by cause, by ingredient, and by supplier (0023).
 * Runs on req.tx so RLS scopes every figure; restricted to FINANCE_ROLES.
 *
 * WASTE IS NOT THE SAME AS EVERYTHING WRITTEN OFF. A staff meal costs exactly
 * as much as a spoiled crate and is not a problem to fix — folding the two
 * together would make a kitchen look worse the better it feeds its people. The
 * four real waste causes are totalled separately from staff meals and from
 * 'other', and the response reports all three.
 *
 * `waste_share_pct` is waste over TOTAL food cost — waste plus the COGS of what
 * actually sold in the same window. That denominator is the point: 4,000 of
 * waste means something very different in a month that sold 20,000 of food than
 * in one that sold 400,000, and an absolute figure alone invites both panic and
 * complacency. It is the ratio the trade benchmarks against (low single digits
 * is healthy), which is why it is computed here rather than left to whoever
 * reads the page.
 *
 * The by-supplier breakdown exists because stock_write_off_lines records the
 * LOT, and a lot knows where it came from. "Whose deliveries keep spoiling" is
 * otherwise unanswerable, and it is the question that turns a waste number into
 * a conversation with a supplier.
 */
export async function getWaste(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  let range;
  try {
    range = parseDateRange(req);
  } catch (err) {
    if (err instanceof DateRangeError) {
      // A window the caller can fix. Substituting a different one silently
      // would hand back figures for a period they did not ask about.
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  const { from, until } = range;

  try {
    const byReason = await req.tx.$queryRaw<
      Array<{
        reason: string;
        is_waste: boolean;
        write_off_count: number;
        quantity: unknown;
        cost: unknown;
        short_count: number;
      }>
    >`
      SELECT w.reason,
             -- Which causes count as waste. Kept in SQL alongside the figures
             -- so the split cannot drift from the totals computed here.
             (w.reason IN ('expired', 'spoiled', 'damaged', 'prep_error')) AS is_waste,
             COUNT(*)::int                                    AS write_off_count,
             COALESCE(SUM(w.quantity_written_off), 0)         AS quantity,
             COALESCE(SUM(w.total_cost), 0)                   AS cost,
             -- Write-offs that exceeded what the books held: each one is a sign
             -- the records were already wrong before anything was discarded.
             COUNT(*) FILTER (WHERE w.quantity_short > 0)::int AS short_count
      FROM public.stock_write_offs w
      WHERE w.created_at >= ${from} AND w.created_at < ${until}
      GROUP BY w.reason
      ORDER BY 5 DESC
    `;

    // Which ingredients are actually going in the bin — the actionable list.
    const byItem = await req.tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        unit_of_measure: string;
        write_off_count: number;
        quantity: unknown;
        cost: unknown;
      }>
    >`
      SELECT r.id,
             r.name,
             r.unit_of_measure,
             COUNT(*)::int                            AS write_off_count,
             COALESCE(SUM(w.quantity_written_off), 0) AS quantity,
             COALESCE(SUM(w.total_cost), 0)           AS cost
      FROM public.stock_write_offs w
      JOIN public.raw_inventory_items r ON r.id = w.raw_item_id
      WHERE w.created_at >= ${from} AND w.created_at < ${until}
        AND w.reason IN ('expired', 'spoiled', 'damaged', 'prep_error')
      GROUP BY r.id, r.name, r.unit_of_measure
      ORDER BY 6 DESC
      LIMIT ${ITEM_CAP}
    `;

    // Whose stock it was. Costed from the LINES, since only they know the lot.
    const bySupplier = await req.tx.$queryRaw<
      Array<{ id: string | null; name: string | null; quantity: unknown; cost: unknown }>
    >`
      SELECT s.id,
             s.name,
             COALESCE(SUM(l.quantity), 0)                 AS quantity,
             COALESCE(SUM(l.quantity * l.unit_cost), 0)   AS cost
      FROM public.stock_write_off_lines l
      JOIN public.stock_write_offs w ON w.id = l.write_off_id
      JOIN public.inventory_batches b ON b.id = l.batch_id
      JOIN public.suppliers s ON s.id = b.supplier_id
      WHERE w.created_at >= ${from} AND w.created_at < ${until}
        AND w.reason IN ('expired', 'spoiled', 'damaged', 'prep_error')
      GROUP BY s.id, s.name
      ORDER BY 4 DESC
      LIMIT ${ITEM_CAP}
    `;

    // The denominator: what the food that actually sold cost, same window, same
    // basis as the profitability report (cost captured at the moment of sale).
    const [sold] = await req.tx.$queryRaw<Array<{ cogs: unknown }>>`
      SELECT COALESCE(SUM(oi.cost_at_sale) FILTER (WHERE oi.cost_is_complete), 0) AS cogs
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
      WHERE o.status = 'completed'
        AND o.created_at >= ${from} AND o.created_at < ${until}
    `;

    const rows = byReason.map((r) => ({
      reason: r.reason,
      is_waste: r.is_waste,
      write_off_count: r.write_off_count,
      quantity: num(r.quantity),
      cost: num(r.cost),
      /** Write-offs here that exceeded recorded stock — the books were already wrong. */
      exceeded_recorded_stock_count: r.short_count,
    }));

    const sumWhere = (pred: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(pred).reduce((s, r) => s + r.cost, 0);

    const wasteCost = sumWhere((r) => r.is_waste);
    const staffMealCost = sumWhere((r) => r.reason === 'staff_meal');
    const otherCost = sumWhere((r) => !r.is_waste && r.reason !== 'staff_meal');
    const cogs = num(sold?.cogs);

    res.status(200).json({
      ...range.label,
      summary: {
        /** Everything discarded, whatever the cause. */
        write_off_cost: wasteCost + staffMealCost + otherCost,
        /** The four causes that represent food destroyed. */
        waste_cost: wasteCost,
        /** Real cost, but not a problem to fix. */
        staff_meal_cost: staffMealCost,
        other_cost: otherCost,
        /** COGS of what sold in the window — the rest of the food cost. */
        cogs,
        /** Waste over total food cost (waste + COGS). Null when nothing moved. */
        waste_share_pct: pct(wasteCost, wasteCost + cogs),
        write_off_count: rows.reduce((s, r) => s + r.write_off_count, 0),
        exceeded_recorded_stock_count: rows.reduce(
          (s, r) => s + r.exceeded_recorded_stock_count,
          0,
        ),
      },
      by_reason: rows,
      by_item: byItem.map((i) => ({
        id: i.id,
        name: i.name,
        unit_of_measure: i.unit_of_measure,
        write_off_count: i.write_off_count,
        quantity: num(i.quantity),
        cost: num(i.cost),
      })),
      by_supplier: bySupplier.map((s) => ({
        id: s.id,
        name: s.name,
        quantity: num(s.quantity),
        cost: num(s.cost),
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.waste] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
