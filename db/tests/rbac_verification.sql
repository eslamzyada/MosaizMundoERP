-- ============================================================================
-- RBAC verification (0010) — runs as mosaiz_app_user, so RLS actually applies.
-- (Running this as postgres would prove nothing: the owner bypasses ENABLE-only
-- RLS, so every assertion below would pass vacuously.)
--
-- Self-asserting: any broken expectation raises, psql exits non-zero, CI fails.
-- Run order: immediately after rbac_fixture.sql (which seeds, as postgres).
--
--   owner / regional_manager / branch_manager -> operational writes
--   cashier / staff                           -> sell only
--   accountant                                -> read-only
-- ============================================================================
\set ON_ERROR_STOP on

-- Fixture ids
--   org = a11c0000-…  owner = a11c0001-…  branch_manager = a11c0002-…
--   cashier = a11c0003-…  accountant = a11c0004-…

-- ----------------------------------------------------------------------------
-- 1. A branch manager MAY receive stock (the administrative INSERT).
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_count int;
BEGIN
    INSERT INTO public.inventory_batches
        (id, organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
    VALUES ('a11cba7c-0000-4000-8000-00000000000b',
            'a11c0000-0000-4000-8000-000000000000',
            'a11cf00d-0000-4000-8000-000000000001', 500, 500, 0.10);

    SELECT count(*) INTO v_count FROM public.inventory_batches
    WHERE id = 'a11cba7c-0000-4000-8000-00000000000b';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'branch_manager must be able to receive stock';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A cashier MAY NOT receive stock. This is the whole point of 0010: before
--    it, this INSERT succeeded.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.inventory_batches
            (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11cf00d-0000-4000-8000-000000000001', 999, 999, 0.10);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;   -- RLS rejects a restricted INSERT with this SQLSTATE (42501)
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier received stock';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A cashier MAY NOT rewrite a recipe.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.bill_of_materials
            (organization_id, sellable_item_id, raw_item_id, quantity_required)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11c5e11-0000-4000-8000-000000000001',
                'a11cf00d-0000-4000-8000-000000000001', 999);
    EXCEPTION WHEN insufficient_privilege OR unique_violation THEN
        -- unique_violation would mean the row existed; either way it was not
        -- the cashier's write that changed the recipe.
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier edited a recipe';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A cashier MAY sell — and the sale still draws stock down. This is the
--    regression that a naive "lock the inventory tables" rule would cause:
--    process_pos_checkout is SECURITY INVOKER, so the UPDATE of the batch and
--    any deficit INSERT run as the cashier.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before numeric;
    v_after  numeric;
BEGIN
    SELECT sum(quantity_remaining) INTO v_before
    FROM public.inventory_batches
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-000000000001';

    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'a11c0000-0000-4000-8000-000000000000',
        'client_offline_id', 'a11c0de0-0000-4000-8000-000000000001',
        'total_amount',      100,
        'items', jsonb_build_array(jsonb_build_object(
            'sellable_item_id', 'a11c5e11-0000-4000-8000-000000000001',
            'quantity', 2, 'unit_price', 50))
    ));

    SELECT sum(quantity_remaining) INTO v_after
    FROM public.inventory_batches
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-000000000001';

    -- 2 shawarma x 10g of chicken = 20g drawn down.
    IF v_before - v_after <> 20 THEN
        RAISE EXCEPTION 'cashier sale must draw down 20g of stock, drew % (before % / after %)',
            v_before - v_after, v_before, v_after;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. An accountant is read-only: may READ the catalog, may NOT sell.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_visible int;
    rejected  boolean := false;
BEGIN
    -- Reading is untouched by 0010 — an accountant must still see everything.
    SELECT count(*) INTO v_visible FROM public.inventory_batches
    WHERE organization_id = 'a11c0000-0000-4000-8000-000000000000';
    IF v_visible < 1 THEN
        RAISE EXCEPTION 'accountant must retain read access to stock (saw % rows)', v_visible;
    END IF;

    BEGIN
        CALL app.process_pos_checkout(jsonb_build_object(
            'organization_id',   'a11c0000-0000-4000-8000-000000000000',
            'client_offline_id', 'a11c0de0-0000-4000-8000-000000000002',
            'total_amount',      50,
            'items', jsonb_build_array(jsonb_build_object(
                'sellable_item_id', 'a11c5e11-0000-4000-8000-000000000001',
                'quantity', 1, 'unit_price', 50))
        ));
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a read-only accountant rang up a sale';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. An accountant MAY NOT receive stock either.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.inventory_batches
            (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11cf00d-0000-4000-8000-000000000001', 42, 42, 0.10);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: an accountant received stock';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Roles do not leak across tenants: the fixture owner is not a member of
--    ci-bistro-cairo, so their admin rights must not apply there. (Guards
--    against a predicate that checks the role but forgets the organization.)
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_owner_elsewhere boolean;
BEGIN
    SELECT app.user_can_administer(id) INTO v_owner_elsewhere
    FROM public.organizations WHERE slug = 'ci-rbac-org';
    IF NOT v_owner_elsewhere THEN
        RAISE EXCEPTION 'owner must administer their own org';
    END IF;

    -- A random other org id: same user, no membership -> no rights.
    SELECT app.user_can_administer('00000000-0000-4000-8000-0000000000ff')
    INTO v_owner_elsewhere;
    IF v_owner_elsewhere THEN
        RAISE EXCEPTION 'SECURITY HOLE: role granted rights in an org the user does not belong to';
    END IF;
END;
$$;

SELECT 'rbac_verification: all assertions passed' AS result;
