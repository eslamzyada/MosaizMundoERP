-- ============================================================================
-- Supplier verification (0020) — runs as mosaiz_app_user, so RLS and the 0010
-- role policies actually apply. Uses the RBAC fixture's org and identities:
--   owner = a11c0001-…  branch_manager = a11c0002-…  cashier = a11c0003-…
--
-- Self-asserting; any broken expectation raises and fails CI.
-- Run order: after rbac_verification.sql (which seeds nothing this needs but
-- shares the fixture), before the COGS fixture.
-- ============================================================================
\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. An admin may add a supplier and attribute a lot to it.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';   -- branch_manager

DO $$
DECLARE
    v_org      uuid := 'a11c0000-0000-4000-8000-000000000000';
    v_supplier uuid := '5099117e-0001-4001-8001-000000000001';
    v_linked   uuid;
BEGIN
    INSERT INTO public.suppliers (id, organization_id, name, phone)
    VALUES (v_supplier, v_org, 'Cairo Foods', '+20 100 000 0000');

    INSERT INTO public.inventory_batches
        (id, organization_id, raw_item_id, quantity_received, quantity_remaining,
         cost_at_purchase, supplier_id)
    VALUES ('5099ba7c-0001-4001-8001-000000000001', v_org,
            'a11cf00d-0000-4000-8000-000000000001', 100, 100, 0.15, v_supplier);

    SELECT supplier_id INTO v_linked FROM public.inventory_batches
    WHERE id = '5099ba7c-0001-4001-8001-000000000001';
    IF v_linked IS DISTINCT FROM v_supplier THEN
        RAISE EXCEPTION 'the lot should carry its supplier, got %', v_linked;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Attribution is OPTIONAL. A lot with no supplier must still be recordable —
--    found stock and pre-0020 deliveries genuinely have none, and blocking them
--    would push users into inventing an attribution.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_supplier uuid;
BEGIN
    INSERT INTO public.inventory_batches
        (id, organization_id, raw_item_id, quantity_received, quantity_remaining,
         cost_at_purchase)
    VALUES ('5099ba7c-0002-4002-8002-000000000002', 'a11c0000-0000-4000-8000-000000000000',
            'a11cf00d-0000-4000-8000-000000000001', 50, 50, 0.20);

    SELECT supplier_id INTO v_supplier FROM public.inventory_batches
    WHERE id = '5099ba7c-0002-4002-8002-000000000002';
    IF v_supplier IS NOT NULL THEN
        RAISE EXCEPTION 'an unattributed lot must keep a NULL supplier, got %', v_supplier;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. THE STRUCTURAL GUARANTEE: a lot cannot be attributed to another tenant's
--    supplier. The composite FK (supplier_id, organization_id) enforces this in
--    the database, so it holds even if an API check is ever forgotten.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    -- A supplier that genuinely EXISTS, in the other CI organization (seeded by
    -- supplier_fixture.sql as postgres, because the app role cannot create a
    -- row in an org it does not belong to). Pointing at a merely non-existent
    -- id would prove far less: any FK rejects that.
    v_foreign uuid := '5099117e-000f-400f-800f-00000000000f';
    v_exists  int;
    rejected  boolean := false;
BEGIN
    -- The supplier is real. RLS hides it from this caller, but the FK is
    -- evaluated by the system, not the caller, so it is the FK that must refuse.
    SELECT count(*) INTO v_exists FROM public.suppliers WHERE id = v_foreign;
    IF v_exists <> 0 THEN
        RAISE EXCEPTION 'RLS should hide the other tenant''s supplier from this caller';
    END IF;

    BEGIN
        INSERT INTO public.inventory_batches
            (organization_id, raw_item_id, quantity_received, quantity_remaining,
             cost_at_purchase, supplier_id)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11cf00d-0000-4000-8000-000000000001', 10, 10, 1.00, v_foreign);
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION
            'SECURITY HOLE: a lot was attributed to a supplier outside its organization';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. One name per organization: a duplicate would split a supplier's own price
--    history across two records.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.suppliers (organization_id, name)
        VALUES ('a11c0000-0000-4000-8000-000000000000', 'Cairo Foods');
    EXCEPTION WHEN unique_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a duplicate supplier name in the same org must be rejected';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A cashier may READ suppliers but not create or change one — buying is
--    administrative, and a supplier record is what purchase prices hang off.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0003-0000-4000-8000-000000000003';   -- cashier

DO $$
DECLARE
    v_visible int;
    rejected  boolean;
    v_name    text;
BEGIN
    SELECT count(*) INTO v_visible FROM public.suppliers
    WHERE organization_id = 'a11c0000-0000-4000-8000-000000000000';
    IF v_visible < 1 THEN
        RAISE EXCEPTION 'a cashier must still be able to read suppliers (saw %)', v_visible;
    END IF;

    rejected := false;
    BEGIN
        INSERT INTO public.suppliers (organization_id, name)
        VALUES ('a11c0000-0000-4000-8000-000000000000', 'Rogue Supplier');
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier created a supplier';
    END IF;

    -- RLS filters the row out of a restricted UPDATE rather than raising, so
    -- assert on the effect.
    BEGIN
        UPDATE public.suppliers SET name = 'Renamed By Cashier'
        WHERE id = '5099117e-0001-4001-8001-000000000001';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    SELECT name INTO v_name FROM public.suppliers
    WHERE id = '5099117e-0001-4001-8001-000000000001';
    IF v_name <> 'Cairo Foods' THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier renamed a supplier to %', v_name;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Deactivating a supplier keeps the history. The point of never deleting
--    one: a supplier dropped in March must not erase what March cost.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';   -- branch_manager

DO $$
DECLARE
    v_active   boolean;
    v_attached int;
BEGIN
    UPDATE public.suppliers SET is_active = false
    WHERE id = '5099117e-0001-4001-8001-000000000001';

    SELECT is_active INTO v_active FROM public.suppliers
    WHERE id = '5099117e-0001-4001-8001-000000000001';
    IF v_active THEN
        RAISE EXCEPTION 'an admin must be able to deactivate a supplier';
    END IF;

    SELECT count(*) INTO v_attached FROM public.inventory_batches
    WHERE supplier_id = '5099117e-0001-4001-8001-000000000001';
    IF v_attached <> 1 THEN
        RAISE EXCEPTION
            'deactivating must not detach past lots (expected 1 still attributed, got %)',
            v_attached;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. The question this exists to answer: what has each supplier charged for an
--    ingredient over time? Two deliveries of the same item at different prices
--    must be attributable and comparable.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_second uuid := '5099117e-0002-4002-8002-000000000002';
    v_rows   int;
    v_spread numeric;
BEGIN
    INSERT INTO public.suppliers (id, organization_id, name)
    VALUES (v_second, 'a11c0000-0000-4000-8000-000000000000', 'Nile Wholesale');

    INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining,
         cost_at_purchase, supplier_id)
    VALUES ('a11c0000-0000-4000-8000-000000000000',
            'a11cf00d-0000-4000-8000-000000000001', 100, 100, 0.25, v_second);

    SELECT count(DISTINCT supplier_id), max(cost_at_purchase) - min(cost_at_purchase)
      INTO v_rows, v_spread
    FROM public.inventory_batches
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-000000000001'
      AND supplier_id IS NOT NULL;

    IF v_rows <> 2 THEN
        RAISE EXCEPTION 'expected two attributed suppliers for the item, got %', v_rows;
    END IF;
    -- 0.25 from one, 0.15 from the other: the comparison the feature exists for.
    IF v_spread IS DISTINCT FROM 0.10 THEN
        RAISE EXCEPTION 'expected a 0.10 price spread between suppliers, got %', v_spread;
    END IF;
END;
$$;

SELECT 'supplier_verification: all assertions passed' AS result;
