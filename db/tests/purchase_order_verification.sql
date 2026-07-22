-- ============================================================================
-- Purchase order verification (0021) — runs as mosaiz_app_user under the RBAC
-- fixture's identities, so RLS and the 0010/0021 policies actually apply:
--   branch_manager = a11c0002-…   cashier = a11c0003-…
-- Builds on the supplier seeded by supplier_verification (Cairo Foods).
--
-- Self-asserting; any broken expectation raises and fails CI.
-- Run order: after supplier_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';   -- branch_manager

-- ----------------------------------------------------------------------------
-- 1. A draft cannot take delivery. Placing is what turns an order into a
--    commitment, so receiving before that would let stock appear against
--    something never actually ordered.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org   uuid := 'a11c0000-0000-4000-8000-000000000000';
    v_po    uuid := '90000001-0001-4001-8001-000000000001';
    v_line  uuid := '90111e01-0001-4001-8001-000000000001';
    rejected boolean := false;
BEGIN
    INSERT INTO public.purchase_orders (id, organization_id, supplier_id, expected_at)
    VALUES (v_po, v_org, '5099117e-0001-4001-8001-000000000001', now() + interval '2 days');

    INSERT INTO public.purchase_order_lines
        (id, purchase_order_id, organization_id, raw_item_id, quantity_ordered, unit_price)
    VALUES (v_line, v_po, v_org, 'a11cf00d-0000-4000-8000-000000000001', 100, 0.20);

    BEGIN
        CALL app.receive_purchase_order_line(v_line, 10);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'receiving against a DRAFT order must be refused';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A partial delivery leaves the order outstanding — and creates real stock,
--    attributed to the order's supplier and traceable to the line.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_po       uuid := '90000001-0001-4001-8001-000000000001';
    v_line     uuid := '90111e01-0001-4001-8001-000000000001';
    v_status   text;
    v_received numeric;
    v_batch    record;
BEGIN
    UPDATE public.purchase_orders SET status = 'placed', placed_at = now() WHERE id = v_po;

    CALL app.receive_purchase_order_line(v_line, 60);

    SELECT quantity_received INTO v_received FROM public.purchase_order_lines WHERE id = v_line;
    IF v_received IS DISTINCT FROM 60.000 THEN
        RAISE EXCEPTION 'the line should record 60 received, got %', v_received;
    END IF;

    -- 40 of 100 still owed, so the order is still outstanding.
    SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
    IF v_status <> 'placed' THEN
        RAISE EXCEPTION 'a partly delivered order must stay placed, got %', v_status;
    END IF;

    SELECT quantity_remaining, cost_at_purchase, supplier_id, purchase_order_line_id
      INTO v_batch
    FROM public.inventory_batches WHERE purchase_order_line_id = v_line;

    IF v_batch.quantity_remaining IS DISTINCT FROM 60.000 THEN
        RAISE EXCEPTION 'the delivery should create a 60-unit lot, got %', v_batch.quantity_remaining;
    END IF;
    -- No explicit cost was given, so the agreed price stands.
    IF v_batch.cost_at_purchase IS DISTINCT FROM 0.20 THEN
        RAISE EXCEPTION 'the lot should cost the agreed 0.20, got %', v_batch.cost_at_purchase;
    END IF;
    IF v_batch.supplier_id IS DISTINCT FROM '5099117e-0001-4001-8001-000000000001'::uuid THEN
        RAISE EXCEPTION 'the lot must be attributed to the order''s supplier';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. The invoice may differ from the quote. A second drop at a higher price is
--    recorded at what was actually charged — that difference is exactly what
--    0020's price history exists to expose — and completing the line closes the
--    order.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_po      uuid := '90000001-0001-4001-8001-000000000001';
    v_line    uuid := '90111e01-0001-4001-8001-000000000001';
    v_status  text;
    v_costs   numeric[];
BEGIN
    CALL app.receive_purchase_order_line(v_line, 40, 0.26);

    SELECT array_agg(cost_at_purchase ORDER BY cost_at_purchase) INTO v_costs
    FROM public.inventory_batches WHERE purchase_order_line_id = v_line;
    IF v_costs IS DISTINCT FROM ARRAY[0.20, 0.26]::numeric[] THEN
        RAISE EXCEPTION 'each delivery keeps the price actually charged, got %', v_costs;
    END IF;

    -- 100 of 100 delivered: nothing outstanding, so the order closes itself.
    SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
    IF v_status <> 'received' THEN
        RAISE EXCEPTION 'a fully delivered order must close itself, got %', v_status;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A closed order cannot take further delivery — it would silently reopen a
--    completed commitment.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        CALL app.receive_purchase_order_line('90111e01-0001-4001-8001-000000000001', 5);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'receiving against a RECEIVED order must be refused';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. OVER-DELIVERY IS RECORDED, NOT REFUSED. 105 against 100 means the shelf
--    holds 105; refusing would force the user to either understate the delivery
--    or leave real stock off the books, both worse than the overage itself.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org      uuid := 'a11c0000-0000-4000-8000-000000000000';
    v_po       uuid := '90000002-0002-4002-8002-000000000002';
    v_line     uuid := '90111e01-0002-4002-8002-000000000002';
    v_received numeric;
    v_status   text;
    v_stock    numeric;
BEGIN
    INSERT INTO public.purchase_orders (id, organization_id, supplier_id, status, placed_at)
    VALUES (v_po, v_org, '5099117e-0001-4001-8001-000000000001', 'placed', now());
    INSERT INTO public.purchase_order_lines
        (id, purchase_order_id, organization_id, raw_item_id, quantity_ordered, unit_price)
    VALUES (v_line, v_po, v_org, 'a11cf00d-0000-4000-8000-000000000001', 100, 0.20);

    CALL app.receive_purchase_order_line(v_line, 105);

    SELECT quantity_received INTO v_received FROM public.purchase_order_lines WHERE id = v_line;
    IF v_received IS DISTINCT FROM 105.000 THEN
        RAISE EXCEPTION 'an over-delivery must be recorded in full, got %', v_received;
    END IF;

    -- Over-delivery counts as met, so the order still closes.
    SELECT status INTO v_status FROM public.purchase_orders WHERE id = v_po;
    IF v_status <> 'received' THEN
        RAISE EXCEPTION 'an over-delivered order must close, got %', v_status;
    END IF;

    -- And the extra 5 really is on the shelf.
    SELECT quantity_remaining INTO v_stock FROM public.inventory_batches
    WHERE purchase_order_line_id = v_line;
    IF v_stock IS DISTINCT FROM 105.000 THEN
        RAISE EXCEPTION 'the full 105 must reach stock, got %', v_stock;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. THE POINT OF THE FEATURE: a short delivery stays visible. An order left
--    part-delivered must remain outstanding with the gap readable, rather than
--    disappearing as it did before 0021.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org       uuid := 'a11c0000-0000-4000-8000-000000000000';
    v_po        uuid := '90000003-0003-4003-8003-000000000003';
    v_line      uuid := '90111e01-0003-4003-8003-000000000003';
    v_short     numeric;
    v_open      int;
BEGIN
    INSERT INTO public.purchase_orders (id, organization_id, supplier_id, status, placed_at)
    VALUES (v_po, v_org, '5099117e-0001-4001-8001-000000000001', 'placed', now());
    INSERT INTO public.purchase_order_lines
        (id, purchase_order_id, organization_id, raw_item_id, quantity_ordered, unit_price)
    VALUES (v_line, v_po, v_org, 'a11cf00d-0000-4000-8000-000000000001', 100, 0.20);

    CALL app.receive_purchase_order_line(v_line, 80);

    SELECT quantity_ordered - quantity_received INTO v_short
    FROM public.purchase_order_lines WHERE id = v_line;
    IF v_short IS DISTINCT FROM 20.000 THEN
        RAISE EXCEPTION 'the shortfall should read 20, got %', v_short;
    END IF;

    SELECT count(*) INTO v_open FROM public.purchase_orders
    WHERE organization_id = v_org AND status = 'placed';
    IF v_open < 1 THEN
        RAISE EXCEPTION 'a short-delivered order must remain outstanding';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Ordering is administrative. A cashier may read what is on order but may
--    not raise one, and may not record a delivery against one.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0003-0000-4000-8000-000000000003';   -- cashier

DO $$
DECLARE
    v_visible int;
    rejected  boolean;
    v_before  numeric;
    v_after   numeric;
BEGIN
    SELECT count(*) INTO v_visible FROM public.purchase_orders
    WHERE organization_id = 'a11c0000-0000-4000-8000-000000000000';
    IF v_visible < 1 THEN
        RAISE EXCEPTION 'a cashier must still be able to read orders (saw %)', v_visible;
    END IF;

    rejected := false;
    BEGIN
        INSERT INTO public.purchase_orders (organization_id, supplier_id)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                '5099117e-0001-4001-8001-000000000001');
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier raised a purchase order';
    END IF;

    -- Recording a delivery writes a stock lot, which 0010 already limits to
    -- admins — so the procedure fails for a cashier and nothing moves.
    SELECT quantity_received INTO v_before FROM public.purchase_order_lines
    WHERE id = '90111e01-0003-4003-8003-000000000003';

    BEGIN
        CALL app.receive_purchase_order_line('90111e01-0003-4003-8003-000000000003', 20);
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;   -- expected
    END;

    SELECT quantity_received INTO v_after FROM public.purchase_order_lines
    WHERE id = '90111e01-0003-4003-8003-000000000003';
    IF v_after IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION
            'SECURITY HOLE: a cashier recorded a delivery (% -> %)', v_before, v_after;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. An order line cannot reference another tenant's ingredient — the composite
--    FK decides that, not the API.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    -- An ingredient owned by the OTHER organization, seeded by
    -- cross_tenant_fixture.sql as postgres. It cannot be discovered by query:
    -- RLS hides other tenants' rows from this caller entirely, which is exactly
    -- why the FK — evaluated by the system, not the caller — has to be the
    -- thing that refuses.
    v_foreign uuid := 'a11cf00d-000f-400f-800f-00000000000f';
    v_visible int;
    rejected  boolean := false;
BEGIN
    SELECT count(*) INTO v_visible FROM public.raw_inventory_items WHERE id = v_foreign;
    IF v_visible <> 0 THEN
        RAISE EXCEPTION 'RLS should hide the other tenant''s ingredient from this caller';
    END IF;

    BEGIN
        INSERT INTO public.purchase_order_lines
            (purchase_order_id, organization_id, raw_item_id, quantity_ordered, unit_price)
        VALUES ('90000003-0003-4003-8003-000000000003',
                'a11c0000-0000-4000-8000-000000000000', v_foreign, 10, 1.00);
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION
            'SECURITY HOLE: an order line referenced another organization''s ingredient';
    END IF;
END;
$$;

SELECT 'purchase_order_verification: all assertions passed' AS result;
