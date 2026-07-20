-- ============================================================================
-- Cost of goods sold verification (0015) — runs as mosaiz_app_user, under the
-- identity of a CASHIER, because that is who rings up sales in production and
-- checkout is SECURITY INVOKER. Running this as postgres would prove nothing:
-- the owner bypasses ENABLE-only RLS, and the 0010 policies would never be
-- exercised.
--
-- Self-asserting: any broken expectation raises, psql exits non-zero, CI fails.
-- Run order: immediately after cogs_fixture.sql.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

-- ----------------------------------------------------------------------------
-- 1. A sale spanning two differently priced lots is costed at what those lots
--    ACTUALLY cost, not at an average of them.
--
--    8 patties = the whole 5-unit lot at 3.00, then 3 from the 10-unit lot at
--    5.00 => 15.00 + 15.00 = 30.00.
--    A weighted average would give 8 x (5*3 + 10*5)/15 = 34.6667, and the
--    equality below rejects it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_cost     numeric;
    v_complete boolean;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c057c0de-0000-4000-8000-000000000001',
        'items', jsonb_build_array(jsonb_build_object(
            'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001', 'quantity', 8))
    ));

    SELECT oi.cost_at_sale, oi.cost_is_complete INTO v_cost, v_complete
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = 'c057c0de-0000-4000-8000-000000000001';

    IF v_cost IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION
            'COGS must be the actual FIFO lot cost 30.00 (5x3.00 + 3x5.00), got %', v_cost;
    END IF;
    IF NOT v_complete THEN
        RAISE EXCEPTION 'a sale fully covered by costed stock must be marked complete';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Selling beyond recorded stock. The part that came out of real lots is
--    costed; the part that did not has no cost basis, so the line is flagged
--    INCOMPLETE. Reporting that reads cost_at_sale without the flag would
--    conclude this sale was unusually profitable, which is backwards.
--
--    7 patties remain, all at 5.00 => 35.00, and 3 go unmet.
--    The same sale also carries an item with NO recipe, which must record as
--    uncosted rather than free.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_burger_cost     numeric;
    v_burger_complete boolean;
    v_bare_cost       numeric;
    v_bare_complete   boolean;
    v_deficit         numeric;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c057c0de-0000-4000-8000-000000000002',
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', 'c0575e11-0000-4000-8000-000000000001', 'quantity', 10),
            jsonb_build_object('sellable_item_id', 'c0575e11-0000-4000-8000-000000000002', 'quantity', 2))
    ));

    SELECT oi.cost_at_sale, oi.cost_is_complete INTO v_burger_cost, v_burger_complete
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = 'c057c0de-0000-4000-8000-000000000002'
      AND oi.sellable_item_id = 'c0575e11-0000-4000-8000-000000000001';

    IF v_burger_cost IS DISTINCT FROM 35.00 THEN
        RAISE EXCEPTION 'short sale must cost the 7 units actually drawn (35.00), got %',
            v_burger_cost;
    END IF;
    IF v_burger_complete THEN
        RAISE EXCEPTION
            'SILENT UNDERSTATEMENT: a sale that outran its stock was marked fully costed';
    END IF;

    SELECT oi.cost_at_sale, oi.cost_is_complete INTO v_bare_cost, v_bare_complete
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = 'c057c0de-0000-4000-8000-000000000002'
      AND oi.sellable_item_id = 'c0575e11-0000-4000-8000-000000000002';

    IF v_bare_cost <> 0 THEN
        RAISE EXCEPTION 'an item with no recipe cannot have drawn stock, got cost %', v_bare_cost;
    END IF;
    IF v_bare_complete THEN
        RAISE EXCEPTION
            'SILENT UNDERSTATEMENT: an item with no recipe was recorded as fully costed (i.e. free)';
    END IF;

    SELECT missing_quantity INTO v_deficit FROM public.inventory_deficits
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_deficit IS DISTINCT FROM 3.000 THEN
        RAISE EXCEPTION 'expected a deficit of 3 unmet units, got %', v_deficit;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Idempotency still holds WITH costing. A replayed checkout (the offline POS
--    retrying) must not create a second order, must not re-deduct stock, and
--    must not double-count either the cost or the deficit.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_orders  int;
    v_cogs    numeric;
    v_deficit numeric;
    v_stock   numeric;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c057c0de-0000-4000-8000-000000000002',
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', 'c0575e11-0000-4000-8000-000000000001', 'quantity', 10),
            jsonb_build_object('sellable_item_id', 'c0575e11-0000-4000-8000-000000000002', 'quantity', 2))
    ));

    SELECT count(*) INTO v_orders FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000002';
    IF v_orders <> 1 THEN
        RAISE EXCEPTION 'a replayed checkout must not create a second order (got %)', v_orders;
    END IF;

    SELECT sum(oi.cost_at_sale) INTO v_cogs
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = 'c057c0de-0000-4000-8000-000000000002';
    IF v_cogs IS DISTINCT FROM 35.00 THEN
        RAISE EXCEPTION 'a replay must not double-count COGS (expected 35.00, got %)', v_cogs;
    END IF;

    SELECT missing_quantity INTO v_deficit FROM public.inventory_deficits
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_deficit IS DISTINCT FROM 3.000 THEN
        RAISE EXCEPTION 'a replay must not re-record the deficit (expected 3, got %)', v_deficit;
    END IF;

    SELECT COALESCE(sum(quantity_remaining), 0) INTO v_stock
    FROM public.inventory_batches WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_stock <> 0 THEN
        RAISE EXCEPTION 'a replay must not re-deduct stock (expected 0 left, got %)', v_stock;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Allocation across lines. Deduction is coalesced per INGREDIENT across the
--    whole cart (0007), so one cheese deduction covers both lines. Each line
--    must be charged in proportion to what it consumed, and the shares must sum
--    back to exactly the ingredient's cost — no cents invented or lost.
--
--    1 Melt (4 cheese) + 1 Toast (2 cheese) = 6 cheese at 0.50 = 3.00 total,
--    split 2.00 / 1.00.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_melt  numeric;
    v_toast numeric;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c057c0de-0000-4000-8000-000000000003',
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', 'c0575e11-0000-4000-8000-000000000003', 'quantity', 1),
            jsonb_build_object('sellable_item_id', 'c0575e11-0000-4000-8000-000000000004', 'quantity', 1))
    ));

    SELECT oi.cost_at_sale INTO v_melt FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = 'c057c0de-0000-4000-8000-000000000003'
      AND oi.sellable_item_id = 'c0575e11-0000-4000-8000-000000000003';

    SELECT oi.cost_at_sale INTO v_toast FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = 'c057c0de-0000-4000-8000-000000000003'
      AND oi.sellable_item_id = 'c0575e11-0000-4000-8000-000000000004';

    IF v_melt IS DISTINCT FROM 2.00 THEN
        RAISE EXCEPTION 'melt consumed 4 of 6 cheese, so it owes 2.00 of the 3.00, got %', v_melt;
    END IF;
    IF v_toast IS DISTINCT FROM 1.00 THEN
        RAISE EXCEPTION 'toast consumed 2 of 6 cheese, so it owes 1.00 of the 3.00, got %', v_toast;
    END IF;
    IF (v_melt + v_toast) <> 3.00 THEN
        RAISE EXCEPTION 'allocated line costs must sum to the ingredient cost 3.00, got %',
            v_melt + v_toast;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. The point of all of this: gross profit is now answerable from history,
--    without consulting today's stock prices at all.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_revenue    numeric;
    v_cogs       numeric;
    v_incomplete int;
BEGIN
    SELECT sum(o.total_amount) INTO v_revenue FROM public.orders o
    WHERE o.organization_id = 'c0570000-0000-4000-8000-000000000000';

    SELECT sum(oi.cost_at_sale),
           count(*) FILTER (WHERE NOT oi.cost_is_complete)
      INTO v_cogs, v_incomplete
    FROM public.order_items oi
    WHERE oi.organization_id = 'c0570000-0000-4000-8000-000000000000';

    -- 8x20 + (10x20 + 2x12) + (15 + 10) = 160 + 224 + 25 = 409
    IF v_revenue IS DISTINCT FROM 409.00 THEN
        RAISE EXCEPTION 'expected revenue 409.00, got %', v_revenue;
    END IF;
    -- 30.00 + 35.00 + 0 + 3.00 = 68.00
    IF v_cogs IS DISTINCT FROM 68.00 THEN
        RAISE EXCEPTION 'expected recorded COGS 68.00, got %', v_cogs;
    END IF;
    -- The two lines that could not be fully costed are still visible as such,
    -- so the margin above is known to be an optimistic bound rather than fact.
    IF v_incomplete <> 2 THEN
        RAISE EXCEPTION 'expected 2 incompletely costed lines, got %', v_incomplete;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. The consumption ledger (0017) records WHICH stock each sale took.
--
--    The first sale drew 8 patties: the whole 5-unit lot at 3.00, then 3 from
--    the 10-unit lot at 5.00. So it must have left exactly two rows, naming
--    those two lots, with those quantities and those costs.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_rows   int;
    v_qty    numeric;
    v_value  numeric;
    v_cheap  numeric;
    v_dear   numeric;
    v_order  uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000001';

    SELECT count(*), sum(quantity), sum(quantity * unit_cost)
      INTO v_rows, v_qty, v_value
    FROM public.inventory_consumption WHERE order_id = v_order;

    IF v_rows <> 2 THEN
        RAISE EXCEPTION 'expected 2 consumption rows (one per lot drawn), got %', v_rows;
    END IF;
    IF v_qty IS DISTINCT FROM 8.000 THEN
        RAISE EXCEPTION 'consumption must account for all 8 units drawn, got %', v_qty;
    END IF;

    -- The ledger must agree with the cost recorded on the sale itself. If these
    -- two ever diverge, one of them is lying about the same event.
    IF v_value IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION 'consumption value must equal the recorded COGS 30.00, got %', v_value;
    END IF;

    SELECT sum(quantity) INTO v_cheap FROM public.inventory_consumption
    WHERE order_id = v_order AND unit_cost = 3.00;
    SELECT sum(quantity) INTO v_dear FROM public.inventory_consumption
    WHERE order_id = v_order AND unit_cost = 5.00;

    IF v_cheap IS DISTINCT FROM 5.000 THEN
        RAISE EXCEPTION 'FIFO must have taken all 5 units of the cheap lot, got %', v_cheap;
    END IF;
    IF v_dear IS DISTINCT FROM 3.000 THEN
        RAISE EXCEPTION 'FIFO must have taken 3 units of the dearer lot, got %', v_dear;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. A shortfall is NOT consumption. Stock that never existed cannot appear in
--    a ledger of stock consumed — it belongs to inventory_deficits alone.
--    The second sale wanted 10 patties and only 7 remained.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_qty   numeric;
    v_order uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000002';

    SELECT COALESCE(sum(quantity), 0) INTO v_qty
    FROM public.inventory_consumption WHERE order_id = v_order;

    IF v_qty IS DISTINCT FROM 7.000 THEN
        RAISE EXCEPTION
            'consumption must record only the 7 units actually drawn, not the 10 wanted (got %)',
            v_qty;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Lot traceability, the other reason this ledger exists: given a lot, which
--    orders did it end up in? Unanswerable before 0017.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_orders int;
BEGIN
    SELECT count(DISTINCT ic.order_id) INTO v_orders
    FROM public.inventory_consumption ic
    JOIN public.inventory_batches b ON b.id = ic.batch_id
    WHERE b.raw_item_id = 'c057f00d-0000-4000-8000-000000000001'
      AND b.cost_at_purchase = 5.00;

    -- The dearer patty lot fed both the 8-unit sale and the short one.
    IF v_orders <> 2 THEN
        RAISE EXCEPTION 'expected the 5.00 lot to trace to 2 orders, got %', v_orders;
    END IF;
END;
$$;

SELECT 'cogs_verification: all assertions passed' AS result;
