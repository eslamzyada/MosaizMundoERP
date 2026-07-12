-- ============================================================================
-- POS checkout verification — runs as mosaiz_app_user (RLS applies).
-- Self-asserting: any broken expectation raises, psql exits non-zero, CI fails.
-- Run order: after rls_verification.sql (relies on the cccc... identity and
-- the ci-bistro-cairo org it provisioned), before admin_checks.sql.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

-- Session-scoped context: the org id (visible through RLS) and a FIXED
-- client_offline_id so the retry below is byte-identical to the first call.
CREATE TEMP TABLE ctx AS
SELECT (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo') AS org_id,
       '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'::uuid                         AS coid;

-- Catalog prerequisite (added with migration 0005): order_items.sellable_item_id
-- now has an FK to sellable_items, so the items referenced below must exist
-- first. Seed them in the caller's org (RLS WITH CHECK passes for the owner).
INSERT INTO public.sellable_items (id, organization_id, name, sku)
SELECT 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid, org_id, 'CI Item A', 'ITEM-A1' FROM ctx
UNION ALL
SELECT 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'::uuid, org_id, 'CI Item B', 'ITEM-B2' FROM ctx;

-- 1. First checkout: must create 1 order with 2 line items.
DO $$
DECLARE
    v_org uuid;
    v_coid uuid;
BEGIN
    SELECT org_id, coid INTO v_org, v_coid FROM ctx;
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', v_coid,
        'total_amount',      25.50,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
                               'quantity', 2, 'unit_price', 10.00),
            jsonb_build_object('sellable_item_id', 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
                               'quantity', 1, 'unit_price', 5.50)
        )
    ));
END;
$$;

-- 2. IDEMPOTENCY: replay the exact same payload TWICE more (aggressive POS
--    retry). Still exactly ONE order and exactly TWO items — never doubled.
DO $$
DECLARE
    v_org uuid;
    v_coid uuid;
    payload jsonb;
    n_orders integer;
    n_items integer;
BEGIN
    SELECT org_id, coid INTO v_org, v_coid FROM ctx;
    payload := jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', v_coid,
        'total_amount',      25.50,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
                               'quantity', 2, 'unit_price', 10.00),
            jsonb_build_object('sellable_item_id', 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
                               'quantity', 1, 'unit_price', 5.50)
        )
    );

    CALL app.process_pos_checkout(payload);   -- retry #1
    CALL app.process_pos_checkout(payload);   -- retry #2

    SELECT count(*) INTO n_orders
    FROM public.orders
    WHERE organization_id = v_org AND client_offline_id = v_coid;

    SELECT count(*) INTO n_items
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = v_coid;

    IF n_orders <> 1 THEN
        RAISE EXCEPTION 'idempotency breach: expected exactly 1 order, found %', n_orders;
    END IF;
    IF n_items <> 2 THEN
        RAISE EXCEPTION 'idempotency breach: expected exactly 2 items, found % (doubled?)', n_items;
    END IF;
    IF (SELECT total_amount FROM public.orders
        WHERE organization_id = v_org AND client_offline_id = v_coid) <> 25.50 THEN
        RAISE EXCEPTION 'order total_amount was not preserved across retries';
    END IF;
END;
$$;

-- 3. A DIFFERENT client_offline_id is a new sale, not a blocked retry.
DO $$
DECLARE
    v_org uuid;
    n_orders integer;
BEGIN
    SELECT org_id INTO v_org FROM ctx;
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e',
        'total_amount',      7.00,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
                               'quantity', 1, 'unit_price', 7.00)
        )
    ));
    SELECT count(*) INTO n_orders FROM public.orders WHERE organization_id = v_org;
    IF n_orders <> 2 THEN
        RAISE EXCEPTION 'new client_offline_id must create a new order (expected 2, found %)', n_orders;
    END IF;
END;
$$;

-- 4. Malformed payload (no items array) must be rejected with a clear error.
DO $$
DECLARE
    v_org uuid;
    rejected boolean := false;
BEGIN
    SELECT org_id INTO v_org FROM ctx;
    BEGIN
        CALL app.process_pos_checkout(jsonb_build_object(
            'organization_id',   v_org,
            'client_offline_id', gen_random_uuid(),
            'total_amount',      1.00
        ));
    EXCEPTION WHEN raise_exception THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'payload without items array must be rejected';
    END IF;
END;
$$;

-- 5. ISOLATION: a stranger session sees no orders and cannot check out into
--    another tenant's org — RLS WITH CHECK (42501) rejects the forged payload.
SET app.current_user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

DO $$
DECLARE
    v_org uuid;
    rejected boolean := false;
BEGIN
    IF (SELECT count(*) FROM public.orders) <> 0
       OR (SELECT count(*) FROM public.order_items) <> 0 THEN
        RAISE EXCEPTION 'isolation breach: stranger can see another tenant''s orders';
    END IF;

    SELECT org_id INTO v_org FROM ctx;   -- temp table: not RLS-protected, test fixture only
    BEGIN
        CALL app.process_pos_checkout(jsonb_build_object(
            'organization_id',   v_org,
            'client_offline_id', gen_random_uuid(),
            'total_amount',      1.00,
            'items', jsonb_build_array(
                jsonb_build_object('sellable_item_id', gen_random_uuid(),
                                   'quantity', 1, 'unit_price', 1.00)
            )
        ));
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            rejected := true;
        ELSE
            RAISE;
        END IF;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'cross-org checkout must be rejected by RLS (SECURITY INVOKER contract)';
    END IF;
END;
$$;

SELECT 'pos_checkout_verification: all assertions passed' AS result;
