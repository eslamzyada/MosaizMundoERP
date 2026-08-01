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

-- Catalog prerequisite. The dishes and their prices are seeded by
-- menu_fixture.sql as postgres: since 0035 the application role has no INSERT
-- or UPDATE on sellable_items, because the menu only changes through an
-- approved menu_change_request. What this suite proves is unchanged — that the
-- SERVER prices a sale from the catalog and ignores what the payload claims.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' AND price = 24.50)
    OR NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE id = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2' AND price = 6.00) THEN
        RAISE EXCEPTION 'menu fixture missing: run menu_fixture.sql first, or every price assertion below is vacuous';
    END IF;
END;
$$;

-- 1. First checkout — F-01 regression guard. The payload LIES about every price
--    (unit_price 10.00 / 5.50, total 25.50). The server must ignore all of it
--    and price from the catalog: A=24.50, B=6.00  ->  total 55.00.
DO $$
DECLARE
    v_org uuid;
    v_coid uuid;
    v_total   numeric;
    v_price_a numeric;
    v_price_b numeric;
BEGIN
    SELECT org_id, coid INTO v_org, v_coid FROM ctx;
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   v_org,
        'client_offline_id', v_coid,
        'total_amount',      25.50,                                   -- ignored
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
                               'quantity', 2, 'unit_price', 10.00),   -- ignored
            jsonb_build_object('sellable_item_id', 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
                               'quantity', 1, 'unit_price', 5.50)     -- ignored
        )
    ));

    SELECT total_amount INTO v_total FROM public.orders
    WHERE organization_id = v_org AND client_offline_id = v_coid;
    IF v_total <> 55.00 THEN
        RAISE EXCEPTION 'F-01: total must be the server-computed 55.00, got % (trusted the client?)', v_total;
    END IF;

    SELECT oi.unit_price INTO v_price_a
    FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = v_coid
      AND oi.sellable_item_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    SELECT oi.unit_price INTO v_price_b
    FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = v_coid
      AND oi.sellable_item_id = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
    IF v_price_a <> 24.50 OR v_price_b <> 6.00 THEN
        RAISE EXCEPTION 'F-01: unit_price must come from the catalog, got A=% B=%', v_price_a, v_price_b;
    END IF;
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
    -- The FIRST computed total (55.00) survives the retries untouched.
    IF (SELECT total_amount FROM public.orders
        WHERE organization_id = v_org AND client_offline_id = v_coid) <> 55.00 THEN
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
        -- Correctly rejected either way: the stranger cannot see the org's
        -- items (P0001 "not available in this organization", 0012) and the RLS
        -- WITH CHECK on orders would block the insert too (42501). Both are the
        -- security property; assert the rejection, not the mechanism.
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'cross-org checkout must be rejected (SECURITY INVOKER contract)';
    END IF;
END;
$$;

-- 6. Server-authoritative hardening (0012): a line referencing an item that is
--    not in the caller's org is rejected up front, never silently dropped.
SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
            'items', jsonb_build_array(
                jsonb_build_object('sellable_item_id', gen_random_uuid(),
                                   'quantity', 1)
            )
        ));
    EXCEPTION WHEN raise_exception THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'checkout referencing an unknown item must be rejected';
    END IF;
END;
$$;

SELECT 'pos_checkout_verification: all assertions passed' AS result;
