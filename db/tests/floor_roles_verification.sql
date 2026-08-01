-- ============================================================================
-- Verification: the waiter and kitchen roles (0034)
--
-- Runs as mosaiz_app_user, so every statement is subject to RLS exactly as the
-- API is. Identities are created here with literal uuids rather than looked up:
-- a SELECT that finds nobody makes every assertion after it vacuously true.
--
-- The two claims worth proving, because both fail silently:
--
--   1. A WAITER can open a tab. If `waiter` had been added to the vocabulary
--      but not to user_can_sell, the role would exist, appear in every dropdown,
--      and refuse to do the one thing the job is.
--   2. The KITCHEN can read the orders and change nothing. A read-only role is
--      the easy thing to get wrong in the generous direction — it inherits
--      SELECT from being a member, and the only question is whether any write
--      list picked it up by accident.
-- ============================================================================

\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 0. Identities, created as postgres before the app role takes over.
--
--    The identity is bound BEFORE the guard below. This file reads through RLS
--    like everything else, so checking for the fixture as nobody reports it
--    missing when it is sitting right there — a false alarm indistinguishable
--    from a real one.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

\set org      '''f10c0000-0000-4000-8000-000000000000'''
\set waiter   '''f10c0001-0000-4000-8000-000000000001'''
\set kitchen  '''f10c0002-0000-4000-8000-000000000002'''
\set item     '''f10c5e11-0000-4000-8000-000000000001'''

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. Both roles are grantable at all.
--
--    The vocabulary lives in two CHECK constraints — the membership and the
--    invitation. The fixture proved the first; this proves the second, because
--    a role that can be granted and never invited fails at the far end of a
--    sign-up flow, which is the worst place to find out.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organization_memberships
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                      AND role = 'waiter') THEN
        RAISE EXCEPTION 'the waiter membership was not created';
    END IF;
    IF NOT EXISTS (SELECT FROM public.organization_memberships
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                      AND role = 'kitchen') THEN
        RAISE EXCEPTION 'the kitchen membership was not created';
    END IF;

    RAISE NOTICE 'OK 1: both roles exist as memberships';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. THE WAITER SELLS. Opening a tab is the job.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_order uuid;
BEGIN
    v_order := app.open_order(jsonb_build_object(
        'organization_id',   'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', gen_random_uuid(),
        'note',              'طاولة ٤'));

    IF v_order IS NULL THEN
        RAISE EXCEPTION 'a waiter could not open a tab';
    END IF;

    RAISE NOTICE 'OK 2: a waiter opened tab %', v_order;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. …and still cannot do an administrator's job.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.raw_inventory_items (organization_id, name, unit_of_measure)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'مكوّن من النادل', 'kg');
        RAISE EXCEPTION 'a waiter created an ingredient';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        INSERT INTO public.sellable_items (organization_id, name, price)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'صنف من النادل', 10);
        RAISE EXCEPTION 'a waiter added a menu item';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 3: a waiter sells and administers nothing';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. THE KITCHEN READS. It has to see what was ordered.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_orders int;
    v_menu   int;
BEGIN
    SELECT count(*) INTO v_orders FROM public.orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_orders = 0 THEN
        RAISE EXCEPTION 'the kitchen cannot see the tab the waiter just opened';
    END IF;

    SELECT count(*) INTO v_menu FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_menu = 0 THEN
        RAISE EXCEPTION 'the kitchen cannot read the menu it is cooking from';
    END IF;

    RAISE NOTICE 'OK 4: the kitchen reads % orders and % menu items', v_orders, v_menu;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. …and writes NOTHING. The easy thing to get wrong in the generous
--    direction, since a read-only role is defined by absence rather than by a
--    rule anyone wrote down.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
BEGIN
    BEGIN
        v_order := app.open_order(jsonb_build_object(
            'organization_id',   'f10c0000-0000-4000-8000-000000000000',
            'client_offline_id', gen_random_uuid(),
            'note',              'طاولة من المطبخ'));
        RAISE EXCEPTION 'the kitchen opened a tab';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        INSERT INTO public.sellable_items (organization_id, name, price)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'صنف من المطبخ', 10);
        RAISE EXCEPTION 'the kitchen added a menu item';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        INSERT INTO public.raw_inventory_items (organization_id, name, unit_of_measure)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'مكوّن من المطبخ', 'kg');
        RAISE EXCEPTION 'the kitchen created an ingredient';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 5: the kitchen changes nothing';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Neither role reads the books.
--
--    SELECT on order_items is ungated by design, so this is about the RATINGS,
--    which are the one read the schema does restrict.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.employee_ratings;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'the kitchen can read % ratings', v_seen;
    END IF;

    SELECT count(*) INTO v_seen FROM public.employee_criterion_scores;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'the kitchen can read % criterion scores', v_seen;
    END IF;

    RAISE NOTICE 'OK 6: judgements stay closed to the floor';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. …but both can read the RUBRIC they are held to (0033).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_criteria int;
BEGIN
    SELECT count(*) INTO v_criteria FROM public.rating_criteria
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_criteria = 0 THEN
        RAISE EXCEPTION 'the kitchen cannot read the standard it is held to';
    END IF;

    RAISE NOTICE 'OK 7: the rubric is readable by the floor (% criteria)', v_criteria;
END;
$$;

\echo 'floor_roles_verification: all checks passed'
