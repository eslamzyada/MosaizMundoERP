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

/**
 * GET /api/reports/inventory-assets?from=&to=  (or ?days=30)
 *
 * Inventory read as an asset rather than as a shopping list: where the money is
 * sitting, how long it has sat there, and how fast it is turning into sales.
 *
 * Stock is usually the largest number on a restaurant's balance sheet and the
 * easiest to stop noticing. The dashboard already showed a single total; this
 * answers the questions that make a total actionable — WHICH ingredient holds
 * the capital, HOW LONG it has been held, and WHETHER it is moving at all.
 *
 * DEGRADES HONESTLY WHEN NOTHING MOVED. Turnover and days-of-cover are
 * divisions by consumption. With no consumption in the window every item would
 * come back as dead stock with infinite cover — technically true, uselessly
 * alarming, and certain to be read as "the kitchen is idle" rather than "no
 * sales have been recorded yet". Those figures are therefore null, and
 * has_usage_data says why, instead of the report inventing a crisis.
 *
 * Value is always quantity_remaining * cost_at_purchase. The recorded invoice
 * (0025) is deliberately not used: that is what a delivery cost, and the
 * question here is what is still on the shelf.
 */
export async function getInventoryAssets(req: Request, res: Response): Promise<void> {
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
  const windowDays = Math.max(1, Math.round((until.getTime() - from.getTime()) / 86_400_000));

  try {
    const rows = await req.tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        unit_of_measure: string;
        is_active: boolean;
        on_hand: unknown;
        capital: unknown;
        oldest_received: Date | null;
        consumed_qty: unknown;
        consumed_cost: unknown;
      }>
    >`
      WITH held AS (
          SELECT b.raw_item_id,
                 SUM(b.quantity_remaining)                      AS on_hand,
                 SUM(b.quantity_remaining * b.cost_at_purchase) AS capital,
                 MIN(b.received_at)                             AS oldest_received
          FROM public.inventory_batches b
          WHERE b.quantity_remaining > 0
          GROUP BY b.raw_item_id
      ),
      -- Everything that took stock OFF the shelf in the window, by both routes:
      -- sold through a dish, and discarded. Counting only sales would report a
      -- heavily-wasted ingredient as slow-moving when it is in fact moving fast
      -- in the wrong direction.
      used AS (
          SELECT raw_item_id, SUM(qty) AS qty, SUM(cost) AS cost
          FROM (
              SELECT c.raw_item_id,
                     SUM(c.quantity)               AS qty,
                     SUM(c.quantity * c.unit_cost) AS cost
              FROM public.inventory_consumption c
              WHERE c.created_at >= ${from} AND c.created_at < ${until}
              GROUP BY c.raw_item_id
              UNION ALL
              SELECT w.raw_item_id,
                     SUM(l.quantity)               AS qty,
                     SUM(l.quantity * l.unit_cost) AS cost
              FROM public.stock_write_off_lines l
              JOIN public.stock_write_offs w ON w.id = l.write_off_id
              WHERE w.created_at >= ${from} AND w.created_at < ${until}
              GROUP BY w.raw_item_id
          ) both_routes
          GROUP BY raw_item_id
      )
      SELECT r.id,
             r.name,
             r.unit_of_measure,
             r.is_active,
             COALESCE(h.on_hand, 0) AS on_hand,
             COALESCE(h.capital, 0) AS capital,
             h.oldest_received,
             COALESCE(u.qty, 0)     AS consumed_qty,
             COALESCE(u.cost, 0)    AS consumed_cost
      FROM public.raw_inventory_items r
      LEFT JOIN held h ON h.raw_item_id = r.id
      LEFT JOIN used u ON u.raw_item_id = r.id
      -- An ingredient holding nothing and used for nothing is not an asset and
      -- not a problem; it is just a name in the catalogue.
      WHERE COALESCE(h.capital, 0) > 0 OR COALESCE(u.qty, 0) > 0
      ORDER BY COALESCE(h.capital, 0) DESC
      LIMIT ${ITEM_CAP}
    `;

    const totalCapital = rows.reduce((s, r) => s + num(r.capital), 0);
    const totalUsedCost = rows.reduce((s, r) => s + num(r.consumed_cost), 0);
    const hasUsage = totalUsedCost > 0;
    const now = Date.now();

    const items = rows.map((r) => {
      const capital = num(r.capital);
      const onHand = num(r.on_hand);
      const usedQty = num(r.consumed_qty);
      const perDay = usedQty / windowDays;

      // How long the shelf would last at the rate it actually moved. Null
      // rather than Infinity when nothing moved: a figure that cannot be
      // compared or sorted is worse than an honest gap.
      //
      // The guard is deliberate even though res.json() would also turn Infinity
      // into null — a counterfactual removing it did NOT fail the suite, because
      // over HTTP the two are indistinguishable. Depending on that would mean
      // depending on a quirk of JSON.stringify, and anything reading this value
      // server-side (a future export, an aggregate) would get Infinity instead.
      const daysOfCover = perDay > 0 ? Math.round((onHand / perDay) * 10) / 10 : null;

      const heldDays = r.oldest_received
        ? Math.floor((now - new Date(r.oldest_received).getTime()) / 86_400_000)
        : null;

      return {
        id: r.id,
        name: r.name,
        unit_of_measure: r.unit_of_measure,
        is_active: r.is_active,
        on_hand: onHand,
        /** Money sitting on the shelf as this ingredient. */
        capital,
        /** Its share of all capital tied up — what turns a big number into a decision. */
        capital_share_pct: pct(capital, totalCapital),
        /** Age of the OLDEST open lot: how long the earliest money has been stuck. */
        days_held: heldDays,
        consumed_quantity: usedQty,
        consumed_cost: num(r.consumed_cost),
        days_of_cover: daysOfCover,
        /**
         * Holds money and did not move at all in the window. Only meaningful
         * when something else DID move — otherwise it means the period has no
         * data, not that this ingredient is stuck.
         */
        is_dead_stock: hasUsage && capital > 0 && usedQty === 0,
      };
    });

    const deadCapital = items.filter((i) => i.is_dead_stock).reduce((s, i) => s + i.capital, 0);

    res.status(200).json({
      ...range.label,
      summary: {
        /** Total money currently sitting as stock. */
        capital_tied_up: totalCapital,
        /** Cost of the stock that left the shelf in the window, sold or binned. */
        stock_consumed_cost: totalUsedCost,
        /**
         * Times the shelf turned over in the window, against CURRENT stock
         * value rather than an average across the period: the system keeps no
         * historical valuation to average, and presenting one would dress an
         * approximation up as an accounting figure.
         */
        turnover:
          totalCapital > 0 && hasUsage
            ? Math.round((totalUsedCost / totalCapital) * 100) / 100
            : null,
        dead_capital: deadCapital,
        dead_capital_pct: hasUsage ? pct(deadCapital, totalCapital) : null,
        /** False means the divisions above are ABSENT, not zero. */
        has_usage_data: hasUsage,
        window_days: windowDays,
      },
      by_item: items,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.inventoryAssets] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/reports/employees?from=&to=  (or ?days=30)
 *
 * How each person actually performed, from what the till recorded (0026).
 *
 * Every figure here is a fact the system observed — orders served, money taken,
 * average order value, how often their sales were voided. Nobody types an
 * opinion, so nothing here can be shaded by who gets on with whom. That is the
 * strength and also the limit: it measures what a till can see, which is not
 * the whole of anyone's job. A manager's judgement lives beside these numbers
 * (phase 3), never averaged into them — combining a fact and an opinion into
 * one score hides which of the two moved it.
 *
 * RANKED AGAINST THE TEAM, NOT AN ABSOLUTE BAR. "142 orders" means nothing on
 * its own; "142 against a team average of 118" is a judgement someone can act
 * on. Every metric therefore carries the team average alongside it.
 *
 * UNATTRIBUTED SALES ARE REPORTED, NOT HIDDEN. Orders placed before 0026 have
 * no server and never will — that information was not captured. They are
 * counted and surfaced as `unattributed`, because a performance report whose
 * per-person totals quietly fail to add up to the business total is worse than
 * one that explains the gap.
 *
 * VOID RATE IS OVER SALES SERVED, not over voids authorised. A manager who
 * authorises many voids is doing their job; a cashier whose OWN sales are
 * frequently voided is the signal worth seeing. voided_by (0018) answers the
 * first question and is deliberately not what this measures.
 */
export async function getEmployeePerformance(req: Request, res: Response): Promise<void> {
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
    const rows = await req.tx.$queryRaw<
      Array<{
        user_id: string | null;
        email: string | null;
        role: string | null;
        is_active: boolean | null;
        orders_served: number;
        revenue: unknown;
        voided_orders: number;
        voided_value: unknown;
      }>
    >`
      SELECT o.served_by                                            AS user_id,
             u.email,
             m.role,
             m.is_active,
             COUNT(*) FILTER (WHERE o.status = 'completed')::int    AS orders_served,
             COALESCE(SUM(o.total_amount)
                      FILTER (WHERE o.status = 'completed'), 0)     AS revenue,
             -- Their OWN sales that ended up voided — not voids they authorised.
             COUNT(*) FILTER (WHERE o.status = 'voided')::int       AS voided_orders,
             COALESCE(SUM(o.total_amount)
                      FILTER (WHERE o.status = 'voided'), 0)        AS voided_value
      FROM public.orders o
      LEFT JOIN public.users u ON u.id = o.served_by
      LEFT JOIN public.organization_memberships m
             ON m.user_id = o.served_by AND m.organization_id = o.organization_id
      WHERE o.created_at >= ${from} AND o.created_at < ${until}
      GROUP BY o.served_by, u.email, m.role, m.is_active
      ORDER BY 6 DESC
      LIMIT ${ITEM_CAP}
    `;

    const attributed = rows.filter((r) => r.user_id !== null);
    const unattributedRow = rows.find((r) => r.user_id === null);

    const teamOrders = attributed.reduce((s, r) => s + r.orders_served, 0);
    const teamRevenue = attributed.reduce((s, r) => s + num(r.revenue), 0);
    const teamVoids = attributed.reduce((s, r) => s + r.voided_orders, 0);
    const headcount = attributed.length;

    // The yardstick each person is measured against. Per-head averages need a
    // head: with nobody attributed there is no team to compare to, and dividing
    // by zero would print a comparison that means nothing.
    const avgOrders = headcount > 0 ? teamOrders / headcount : null;
    const avgRevenue = headcount > 0 ? teamRevenue / headcount : null;
    const avgOrderValue = teamOrders > 0 ? teamRevenue / teamOrders : null;
    const teamVoidRate = pct(teamVoids, teamOrders + teamVoids);

    const employees = attributed.map((r) => {
      const orders = r.orders_served;
      const revenue = num(r.revenue);
      const voided = r.voided_orders;

      return {
        user_id: r.user_id,
        email: r.email,
        role: r.role,
        /** A former employee still has a record; the flag says they have left. */
        is_active: r.is_active,
        orders_served: orders,
        revenue,
        /** What a typical order they served was worth. */
        average_order_value: orders > 0 ? Math.round((revenue / orders) * 100) / 100 : null,
        voided_orders: voided,
        voided_value: num(r.voided_value),
        /**
         * Share of THEIR sales that were voided. Denominator includes the voids
         * themselves: a void was still an order they rang up.
         */
        void_rate_pct: pct(voided, orders + voided),
        /** Share of the team's takings that came through this person. */
        revenue_share_pct: pct(revenue, teamRevenue),
      };
    });

    res.status(200).json({
      ...range.label,
      team: {
        headcount,
        orders_served: teamOrders,
        revenue: teamRevenue,
        average_orders_per_person: avgOrders === null ? null : Math.round(avgOrders * 10) / 10,
        average_revenue_per_person:
          avgRevenue === null ? null : Math.round(avgRevenue * 100) / 100,
        average_order_value:
          avgOrderValue === null ? null : Math.round(avgOrderValue * 100) / 100,
        void_rate_pct: teamVoidRate,
      },
      /**
       * Sales with no recorded server. Always present as a figure, so the
       * per-person totals can be reconciled against the business total rather
       * than silently differing from it.
       */
      unattributed: {
        orders_served: unattributedRow ? unattributedRow.orders_served : 0,
        revenue: unattributedRow ? num(unattributedRow.revenue) : 0,
        /** True while any sale in the window predates attribution (0026). */
        present: unattributedRow !== undefined,
      },
      employees,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[reports.employees] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
