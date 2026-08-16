-- ============================================================================
-- 0050_report_indexes.sql — three indexes, each one measured
--
-- 0049 made the tenant predicate something the planner can use. That fixed
-- every query whose work was on `orders` itself. It did nothing for the ones
-- that then walk INTO a child table, because those still find their rows by
-- order_id and check the tenant afterwards, one row at a time.
--
-- Measured the same way as 0049: a year of trading (460k orders, 300k order
-- lines, 150k consumption rows) across 14 restaurants sharing one database,
-- best of three warm runs.
--
--     cost of sales, 30 days      ~250 ms  ->  58 ms
--     POS menu, stock on hand      101 ms  ->  3.3 ms
--     COGS by ingredient, 30 days  303 ms  ->  90 ms
--
-- ----------------------------------------------------------------------------
-- WHY organization_id LEADS, AND WHY THAT IS NEW.
--
-- Before 0049 an index leading with organization_id was nearly useless: the
-- policy was an opaque function, so the planner could not put the tenant into
-- an index condition and would not choose such an index. Since 0049 it can,
-- which is what makes these three worth adding TODAY and not before.
--
-- The INCLUDE columns are the ones the aggregates read. With them the scan is
-- index-only and never touches the heap.
--
-- ----------------------------------------------------------------------------
-- MEASURED AND REJECTED, recorded so nobody adds them on principle later:
--
--   * notifications. The bell looked catastrophic at 924 ms until the data was
--     examined: the benchmark had 60,000 alerts addressed to a reader in
--     restaurants they do not belong to. app.notify_roles only ever writes to
--     MEMBERS, so that shape cannot occur. With a realistic two years of
--     alerts inside one restaurant the bell is 0.5 ms on the existing
--     notifications_inbox_idx. No index needed; adding one would have been
--     pure write cost bought with a benchmark that lied.
--
--   * order_items (order_id) INCLUDE (...). An index-only scan with ZERO heap
--     fetches, and SLOWER than the plain order_id index it replaced — 259 ms
--     against ~250 ms. A wider index costs more to descend than it saves.
--     "Index-only" is not a synonym for "faster".
--
--   * The other 30-odd unindexed foreign keys. Real, and not measured to cost
--     anything on a query this system actually runs. An index that no measured
--     query uses is a write tax with no payer.
--
-- ----------------------------------------------------------------------------
-- WHAT THESE COST. order_items is the hottest write path in the system, so it
-- was measured too: 5,000 lines inserted in 1,872 ms without the index and
-- 1,680 ms with it — the difference is inside the noise. The index is 19 MB
-- against a 44 MB table.
-- ============================================================================

BEGIN;

-- The reports: profit, trends, employee takings, exports. All of them walk
-- from a window of orders into their lines.
CREATE INDEX order_items_org_order_idx
    ON public.order_items (organization_id, order_id)
    INCLUDE (quantity, unit_price, cost_at_sale);

COMMENT ON INDEX public.order_items_org_order_idx IS
    'Reports walking from a window of orders into their lines (0050). Tenant leads because 0049 made that an index condition; the INCLUDE keeps the aggregate off the heap. ~250ms -> 58ms on a year of trading across 14 tenants.';

-- The POS menu. Every till load asks what is in stock, and it asked by
-- scanning every batch in the database.
--
-- Partial on the same predicate the query uses: an empty batch is history, and
-- most rows become history. The existing fifo index leads with raw_item_id,
-- which serves the deduction path and cannot serve this one.
CREATE INDEX inventory_batches_org_item_idx
    ON public.inventory_batches (organization_id, raw_item_id)
    WHERE quantity_remaining > 0;

COMMENT ON INDEX public.inventory_batches_org_item_idx IS
    'Stock on hand per ingredient, for the POS menu (0050). Partial: an empty batch is history. 101ms -> 3.3ms.';

-- Cost of goods by ingredient: the waste and profitability reports.
CREATE INDEX inventory_consumption_org_order_idx
    ON public.inventory_consumption (organization_id, order_id)
    INCLUDE (raw_item_id, quantity, unit_cost);

COMMENT ON INDEX public.inventory_consumption_org_order_idx IS
    'COGS by ingredient over a window of orders (0050). 303ms -> 90ms.';

COMMIT;
