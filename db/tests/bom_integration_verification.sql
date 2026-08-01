-- ============================================================================
-- BOM integration verification — runs as mosaiz_app_user (RLS applies).
-- Proves the grand integration: a POS checkout resolves each cart line through
-- bill_of_materials and draws down raw stock FIFO.
-- Self-asserting; any broken expectation raises and fails CI.
-- Run order: after inventory_fifo_verification.sql, before admin_checks.sql.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

-- ----------------------------------------------------------------------------
-- 1. Required scenario: 1 raw "Beef Patty" (batch of 10), 1 sellable "Burger"
--    linked to 1 patty via the BOM. Checkout 3 burgers -> batch has 7 left.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org    uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_patty  uuid := 'beef0001-0001-4001-8001-000000000001';
    -- Seeded by menu_fixture as postgres (0035).
    v_burger uuid := 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
    v_batch  uuid := 'ba7c1000-000a-4000-8000-00000000000a';
    v_remaining numeric;
    v_orders    integer;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_patty, v_org, 'Beef Patty', 'pieces');

    -- 0035 took the menu away from the application role, and this suite runs
    -- as it, so the dish is seeded by menu_fixture and only checked here.
    IF NOT EXISTS (SELECT FROM public.sellable_items WHERE id = v_burger) THEN
        RAISE EXCEPTION 'menu fixture missing: Burger was not seeded';
    END IF;

    INSERT INTO public.inventory_batches
        (id, organization_id, raw_item_id, quantity_received,
         quantity_remaining, cost_at_purchase, expiry_date, received_at)
    VALUES (v_batch, v_org, v_patty, 10, 10, 3.00, now() + interval '5 days', now());

    -- Recipe: one Burger consumes one Beef Patty.
    INSERT INTO public.bill_of_materials
        (organization_id, sellable_item_id, raw_item_id, quantity_required)
    VALUES (v_org, v_burger, v_patty, 1);

    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', 'c0ffee01-0001-4001-8001-000000000001',
        'total_amount',      30.00,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', v_burger, 'quantity', 3, 'unit_price', 10.00)
        )
    ));

    SELECT quantity_remaining INTO v_remaining
    FROM public.inventory_batches WHERE id = v_batch;
    IF v_remaining <> 7 THEN
        RAISE EXCEPTION 'BOM integration breach: 3 burgers x 1 patty should leave 7, got %', v_remaining;
    END IF;

    SELECT count(*) INTO v_orders
    FROM public.orders WHERE client_offline_id = 'c0ffee01-0001-4001-8001-000000000001';
    IF v_orders <> 1 THEN
        RAISE EXCEPTION 'checkout should have created exactly 1 order, got %', v_orders;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Idempotency end-to-end: replaying the SAME checkout must not deduct
--    again. Batch stays at 7 (no double draw-down on POS retry).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_batch uuid := 'ba7c1000-000a-4000-8000-00000000000a';
    -- Seeded by menu_fixture as postgres (0035).
    v_burger uuid := 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
    v_org uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_remaining numeric;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', 'c0ffee01-0001-4001-8001-000000000001',   -- same as scenario 1
        'total_amount',      30.00,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', v_burger, 'quantity', 3, 'unit_price', 10.00)
        )
    ));

    SELECT quantity_remaining INTO v_remaining
    FROM public.inventory_batches WHERE id = v_batch;
    IF v_remaining <> 7 THEN
        RAISE EXCEPTION 'idempotency breach: replayed checkout re-deducted stock (batch = %, expected 7)', v_remaining;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Deficit through checkout: order 10 burgers with only 7 patties left.
--    The sale still completes, the batch drains to 0, and a deficit of 3 is
--    recorded against the raw item — the cashier is never blocked.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org    uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_patty  uuid := 'beef0001-0001-4001-8001-000000000001';
    -- Seeded by menu_fixture as postgres (0035).
    v_burger uuid := 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
    v_batch  uuid := 'ba7c1000-000a-4000-8000-00000000000a';
    v_remaining numeric;
    v_deficit   numeric;
    v_orders    integer;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', 'c0ffee02-0002-4002-8002-000000000002',
        'total_amount',      100.00,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', v_burger, 'quantity', 10, 'unit_price', 10.00)
        )
    ));

    SELECT quantity_remaining INTO v_remaining
    FROM public.inventory_batches WHERE id = v_batch;
    IF v_remaining <> 0 THEN
        RAISE EXCEPTION 'deficit checkout: batch should drain to 0, got %', v_remaining;
    END IF;

    SELECT missing_quantity INTO v_deficit
    FROM public.inventory_deficits
    WHERE raw_item_id = v_patty AND organization_id = v_org;
    IF v_deficit IS DISTINCT FROM 3 THEN
        RAISE EXCEPTION 'deficit checkout: expected a recorded shortfall of 3 patties, got %', v_deficit;
    END IF;

    SELECT count(*) INTO v_orders
    FROM public.orders WHERE client_offline_id = 'c0ffee02-0002-4002-8002-000000000002';
    IF v_orders <> 1 THEN
        RAISE EXCEPTION 'deficit checkout must still create the order, got % orders', v_orders;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Cart coalescing (0007): three SEPARATE lines of the same item, with zero
--    stock, must produce exactly ONE deduction — i.e. a single deficit row of
--    3, not three rows of 1. This is the observable signature of coalescing.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org  uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw  uuid := 'c0a1e5ce-0001-4001-8001-000000000001';
    v_sell uuid := 'c0a1e5ce-0002-4002-8002-000000000002';
    v_line jsonb;
    v_rows    integer;
    v_missing numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_raw, v_org, 'Coalesce Cheese', 'grams');   -- no batch: zero stock
    v_sell := 'c0a1e5ce-0000-4000-8000-00000000000f';
    IF NOT EXISTS (SELECT FROM public.sellable_items WHERE id = v_sell) THEN
        RAISE EXCEPTION 'menu fixture missing: Coalesce Item was not seeded';
    END IF;
    INSERT INTO public.bill_of_materials
        (organization_id, sellable_item_id, raw_item_id, quantity_required)
    VALUES (v_org, v_sell, v_raw, 1);

    -- Three distinct cart lines for the same sellable (cashier tapped x3).
    v_line := jsonb_build_object('sellable_item_id', v_sell, 'quantity', 1, 'unit_price', 4.00);
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', 'c0a1e5ce-0003-4003-8003-000000000003',
        'total_amount',      12.00,
        'items', jsonb_build_array(v_line, v_line, v_line)
    ));

    SELECT count(*), COALESCE(max(missing_quantity), 0)
    INTO v_rows, v_missing
    FROM public.inventory_deficits
    WHERE raw_item_id = v_raw AND organization_id = v_org;

    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'coalescing breach: expected 1 deficit row, got % (lines not coalesced)', v_rows;
    END IF;
    IF v_missing <> 3 THEN
        RAISE EXCEPTION 'coalescing breach: expected a single deficit of 3, got %', v_missing;
    END IF;
END;
$$;

SELECT 'bom_integration_verification: all assertions passed' AS result;
