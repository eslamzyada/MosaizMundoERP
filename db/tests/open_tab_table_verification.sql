-- ============================================================================
-- Verification: opening a tab AT a table (0045)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization   f10c0001 waiter   f10c0004 owner
--
-- 0043 put the guarantee in the schema — a composite FK that cannot cross
-- tenants, and a partial unique index allowing one open tab per table. What
-- this proves is that the TILL now reaches them, and that the refusals arrive
-- as sentences a waiter can act on rather than as constraint names.
--
-- The claims:
--
--   1. A tab opened at a table is linked to it, not described by it.
--   2. One table, one tab — and the refusal names the table.
--   3. A retried open is still idempotent, and is NOT told the table is busy
--      by its own tab. This is the one a naive implementation gets wrong, and
--      it breaks exactly when the wifi is bad, which is when it matters.
--   4. Another restaurant's table is refused, and refused as a bad request
--      rather than as a missing order.
--   5. Settling frees the table.
--   6. A tab with no table still works, because takeaway exists.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;
END;
$$;

-- The floor plan lives in the `reservations` module, which ships OFF (0039) —
-- a restaurant is not assumed to take bookings. Switched on here rather than
-- assumed from whichever suite ran before, so this one stands alone.
SELECT app.set_module('f10c0000-0000-4000-8000-000000000000', 'reservations', true);

-- Two tables of our own, so nothing here depends on another suite's floor plan.
INSERT INTO public.restaurant_tables (id, organization_id, label, seats) VALUES
    ('7ab1e001-0000-4000-8000-000000000001',
     'f10c0000-0000-4000-8000-000000000000', 'طاولة الفوترة ١', 4),
    ('7ab1e002-0000-4000-8000-000000000002',
     'f10c0000-0000-4000-8000-000000000000', 'طاولة الفوترة ٢', 2)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 1. A waiter opens a tab AT a table, and the link is a row, not a sentence.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_order uuid;
BEGIN
    v_order := app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', '7ab1c0de-0000-4000-8000-000000000001',
        'table_id', '7ab1e001-0000-4000-8000-000000000001'));

    IF (SELECT table_id FROM public.orders WHERE id = v_order)
       IS DISTINCT FROM '7ab1e001-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'the tab was not linked to the table';
    END IF;

    -- Still an EMPTY tab, which is the honest record of a party that has been
    -- seated and handed menus. 0029's promise, unchanged.
    IF EXISTS (SELECT FROM public.order_items WHERE order_id = v_order) THEN
        RAISE EXCEPTION 'opening a tab invented items';
    END IF;

    RAISE NOTICE 'OK 1: a tab opened at a table is linked to it';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. One table, one tab. And the refusal says WHICH table.
--
--    A different client_offline_id, because the same one would take the
--    idempotent path and prove nothing about the constraint.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_msg   text;
    v_state text;
BEGIN
    BEGIN
        PERFORM app.open_order(jsonb_build_object(
            'organization_id', 'f10c0000-0000-4000-8000-000000000000',
            'client_offline_id', '7ab1c0de-0000-4000-8000-000000000002',
            'table_id', '7ab1e001-0000-4000-8000-000000000001'));
        RAISE EXCEPTION 'a second tab was opened on a table that already had one';
    EXCEPTION
        WHEN object_not_in_prerequisite_state THEN
            GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
            -- The waiter has to know which table, because they are holding a
            -- tablet in a room with twenty of them.
            IF v_msg NOT LIKE '%طاولة الفوترة ١%' THEN
                RAISE EXCEPTION 'the refusal does not name the table: %', v_msg;
            END IF;
    END;

    -- And the second tab really does not exist — the refusal is not cosmetic.
    IF (SELECT count(*) FROM public.orders
         WHERE table_id = '7ab1e001-0000-4000-8000-000000000001'
           AND status = 'open') <> 1 THEN
        RAISE EXCEPTION 'the table is running more than one tab';
    END IF;

    RAISE NOTICE 'OK 2: one table, one tab, and the refusal names it';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS OFFLINE.
--
--    The till retries when the wifi drops. A retry carries the SAME
--    client_offline_id, so it finds its own tab already sitting at the table —
--    and must be handed that tab back, not told the table is busy by itself.
--    An implementation that checks "is any tab open here" without excluding
--    the caller's own passes check 2 and breaks every reconnect.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_first  uuid;
    v_again  uuid;
BEGIN
    SELECT id INTO v_first FROM public.orders
     WHERE client_offline_id = '7ab1c0de-0000-4000-8000-000000000001';

    v_again := app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', '7ab1c0de-0000-4000-8000-000000000001',
        'table_id', '7ab1e001-0000-4000-8000-000000000001'));

    IF v_again IS DISTINCT FROM v_first THEN
        RAISE EXCEPTION 'a retry did not return the same tab';
    END IF;

    IF (SELECT count(*) FROM public.orders
         WHERE table_id = '7ab1e001-0000-4000-8000-000000000001'
           AND status = 'open') <> 1 THEN
        RAISE EXCEPTION 'the retry opened a second tab';
    END IF;

    RAISE NOTICE 'OK 3: a retry gets its own tab back, not a busy-table refusal';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Another restaurant's table.
--
--    Addressed by id, from OUR organization — the cross-tenant test that
--    actually tests something. Asking as the other tenant would be refused by
--    the organization check before any of this ran.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_foreign uuid;
BEGIN
    -- The literal id from floor_roles_fixture.sql, NOT a lookup by
    -- organization_id: that row belongs to another restaurant, so RLS hides it
    -- from this caller and the lookup would find nothing — leaving the attempt
    -- below to be made with NULL, which every branch accepts. The fixture
    -- exists precisely so this can be addressed directly.
    v_foreign := '7ab1e000-000f-400f-800f-00000000000f';

    BEGIN
        PERFORM app.open_order(jsonb_build_object(
            'organization_id', 'f10c0000-0000-4000-8000-000000000000',
            'client_offline_id', '7ab1c0de-0000-4000-8000-000000000003',
            'table_id', v_foreign));
        RAISE EXCEPTION 'a tab was opened on another restaurant''s table';
    EXCEPTION
        WHEN invalid_parameter_value THEN NULL;
        WHEN foreign_key_violation THEN
            -- 0043's FK would also stop this, but it arrives as a constraint
            -- name. Reaching it means the check in open_order did not fire.
            RAISE EXCEPTION 'the foreign table was caught by the FK, not by open_order';
    END;

    RAISE NOTICE 'OK 4: another restaurant''s table is not on this floor plan';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Settling frees the table. Otherwise a restaurant can seat each table
--    exactly once per lifetime, which would be a memorable bug.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_next  uuid;
    v_dish  uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
     WHERE client_offline_id = '7ab1c0de-0000-4000-8000-000000000001';

    -- A tab cannot be settled empty, and its lines must have been fired — the
    -- lifecycle 0043's suite had to learn the hard way.
    SELECT id INTO v_dish FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND is_active LIMIT 1;

    PERFORM app.add_order_items(v_order, jsonb_build_array(
        jsonb_build_object('sellable_item_id', v_dish, 'quantity', 1)));
    PERFORM app.fire_order(v_order);
    PERFORM app.settle_order(v_order);

    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'completed' THEN
        RAISE EXCEPTION 'the tab did not settle';
    END IF;

    -- The table is free again, and the proof is that it can be used.
    v_next := app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', '7ab1c0de-0000-4000-8000-000000000004',
        'table_id', '7ab1e001-0000-4000-8000-000000000001'));

    IF v_next IS NULL THEN
        RAISE EXCEPTION 'the table was not freed by settling';
    END IF;

    -- And the settled tab KEEPS its table. A report about last night has to be
    -- able to say which table it was; clearing the link on settle would make
    -- the index simpler and the history useless.
    IF (SELECT table_id FROM public.orders WHERE id = v_order) IS NULL THEN
        RAISE EXCEPTION 'settling forgot which table it was';
    END IF;

    RAISE NOTICE 'OK 5: settling frees the table and remembers it';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Takeaway. No table, and none needed — a restaurant without the
--    reservations module has no floor plan at all, and its till must work.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
BEGIN
    v_order := app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', '7ab1c0de-0000-4000-8000-000000000005',
        'note', 'تيك أواي'));

    IF v_order IS NULL THEN
        RAISE EXCEPTION 'a tab with no table could not be opened';
    END IF;
    IF (SELECT table_id FROM public.orders WHERE id = v_order) IS NOT NULL THEN
        RAISE EXCEPTION 'a table was invented for a takeaway order';
    END IF;

    -- Two of them at once, which the one-tab-per-table index must not touch:
    -- NULLs are distinct, and a restaurant runs many takeaway orders at once.
    PERFORM app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', '7ab1c0de-0000-4000-8000-000000000006',
        'note', 'تيك أواي ٢'));

    IF (SELECT count(*) FROM public.orders
         WHERE status = 'open' AND table_id IS NULL
           AND client_offline_id IN ('7ab1c0de-0000-4000-8000-000000000005',
                                     '7ab1c0de-0000-4000-8000-000000000006')) <> 2 THEN
        RAISE EXCEPTION 'two takeaway tabs could not run at once';
    END IF;

    RAISE NOTICE 'OK 6: no table is a valid answer, and many of them at once';
END;
$$;

\echo 'open_tab_table_verification: all checks passed'
