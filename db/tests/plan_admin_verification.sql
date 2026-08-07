-- ============================================================================
-- Verification: moving a plan (0044)
--
-- Runs as POSTGRES, because app.change_plan is deliberately not granted to the
-- application role: there is no payment flow, so billing is an operator action,
-- and a tenant able to call this could promote itself for free. That refusal is
-- asserted from the other side in plan_verification.sql.
--
-- The claims:
--
--   1. An upgrade grants, and does it without anybody touching a toggle.
--   2. A downgrade takes back — but takes back the ABILITY TO WRITE, never the
--      record of what was written. This is the one that would make the books
--      lie, so it is asserted by counting the same rows before and after.
--   3. It is written down, and the owner is told. A screen that vanishes with
--      no explanation becomes a support ticket.
--   4. An explicit plan change ends grandfathering. The promise was to protect
--      tenants from the migration, not to hand out a permanent entitlement.
--   5. plan_tier moves ONLY through here.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- A restaurant of its own, so nothing here depends on another suite's state.
INSERT INTO public.organizations (id, name, slug, plan_tier)
VALUES ('91a40000-0000-4000-8000-000000000000', 'Plan Test Org', 'plan-test-org', 'basic');

INSERT INTO public.users (id, email) VALUES
    ('91a40001-0000-4000-8000-000000000001', 'plan-owner@dev.local'),
    -- Somebody to rate. An owner may not rate itself, and the rating is the
    -- evidence that has to survive the downgrade in check 4.
    ('91a40002-0000-4000-8000-000000000002', 'plan-staff@dev.local'),
    -- A second person who should hear about the bill. notify_roles skips the
    -- actor on purpose — you do not need telling about what you just did — so
    -- without somebody else in the room check 5 would prove nothing.
    ('91a40003-0000-4000-8000-000000000003', 'plan-regional@dev.local');

INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES
    ('91a40000-0000-4000-8000-000000000000',
     '91a40001-0000-4000-8000-000000000001', 'owner'),
    ('91a40000-0000-4000-8000-000000000000',
     '91a40002-0000-4000-8000-000000000002', 'waiter'),
    ('91a40000-0000-4000-8000-000000000000',
     '91a40003-0000-4000-8000-000000000003', 'regional_manager');

SET app.current_user_id = '91a40001-0000-4000-8000-000000000001';

-- ----------------------------------------------------------------------------
-- 1. Where it starts: basic, so the premium shelf is out of reach and the
--    catalogue default does not smuggle it in.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_org uuid := '91a40000-0000-4000-8000-000000000000';
BEGIN
    IF app.org_has_module(v_org, 'insights') THEN
        RAISE EXCEPTION 'a fresh basic tenant runs insights';
    END IF;
    IF NOT app.org_has_module(v_org, 'inventory') THEN
        RAISE EXCEPTION 'a fresh basic tenant does not run inventory';
    END IF;
    RAISE NOTICE 'OK 1: basic gets basic';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. An upgrade grants, with no toggle touched.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := '91a40000-0000-4000-8000-000000000000';
    v_id  uuid;
BEGIN
    v_id := app.change_plan(v_org, 'premium', 'paid up');

    IF (SELECT plan_tier FROM public.organizations WHERE id = v_org) <> 'premium' THEN
        RAISE EXCEPTION 'the plan did not move';
    END IF;
    IF NOT app.org_has_module(v_org, 'insights') THEN
        RAISE EXCEPTION 'insights did not follow the upgrade';
    END IF;
    IF app.org_has_module(v_org, 'menu_approval') THEN
        RAISE EXCEPTION 'premium reached an enterprise module';
    END IF;

    -- Written down, with the reason and the actor.
    IF NOT EXISTS (
        SELECT FROM public.plan_changes
         WHERE id = v_id AND from_plan = 'basic' AND to_plan = 'premium'
           AND reason = 'paid up'
           AND changed_by = '91a40001-0000-4000-8000-000000000001') THEN
        RAISE EXCEPTION 'the upgrade was not recorded properly';
    END IF;

    RAISE NOTICE 'OK 2: an upgrade grants and is recorded';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Work happens under the premium plan. This is the evidence that must
--    survive the downgrade in check 4.
-- ----------------------------------------------------------------------------
INSERT INTO public.employee_ratings
    (organization_id, employee_id, rated_by, period_month, score)
VALUES ('91a40000-0000-4000-8000-000000000000',
        '91a40002-0000-4000-8000-000000000002',
        '91a40001-0000-4000-8000-000000000001',
        date_trunc('month', current_date)::date, 4);

-- ----------------------------------------------------------------------------
-- 4. A downgrade takes back the ability to write, and NOTHING else.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org    uuid := '91a40000-0000-4000-8000-000000000000';
    v_before bigint;
    v_after  bigint;
    v_id     uuid;
    v_off    text[];
BEGIN
    SELECT count(*) INTO v_before FROM public.employee_ratings WHERE organization_id = v_org;
    IF v_before = 0 THEN
        RAISE EXCEPTION 'no evidence was written, so surviving proves nothing';
    END IF;

    -- Something explicitly switched ON under premium, so the downgrade has a
    -- real row to turn off rather than only a default to stop granting.
    PERFORM app.set_module(v_org, 'performance', true);
    IF NOT EXISTS (SELECT FROM public.organization_modules
                    WHERE organization_id = v_org AND module_key = 'performance' AND enabled) THEN
        RAISE EXCEPTION 'setup: performance is not explicitly on';
    END IF;

    v_id := app.change_plan(v_org, 'basic', 'stopped paying');

    SELECT count(*) INTO v_after FROM public.employee_ratings WHERE organization_id = v_org;
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'a downgrade deleted % rows of history', v_before - v_after;
    END IF;

    IF app.org_has_module(v_org, 'performance') THEN
        RAISE EXCEPTION 'performance survived a downgrade below its plan';
    END IF;
    IF app.org_has_module(v_org, 'insights') THEN
        RAISE EXCEPTION 'insights survived a downgrade below its plan';
    END IF;
    IF NOT app.org_has_module(v_org, 'inventory') THEN
        RAISE EXCEPTION 'a downgrade took away a module basic includes';
    END IF;

    SELECT modules_disabled INTO v_off FROM public.plan_changes WHERE id = v_id;
    IF NOT ('performance' = ANY (v_off)) THEN
        RAISE EXCEPTION 'the record does not say performance was switched off: %', v_off;
    END IF;

    RAISE NOTICE 'OK 4: a downgrade removes the ability to write, not the record';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Somebody was told. A capability that disappears silently is a support
--    ticket in a fortnight.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_org uuid := '91a40000-0000-4000-8000-000000000000';
BEGIN
    IF NOT EXISTS (
        SELECT FROM public.notifications
         WHERE organization_id = v_org
           AND kind = 'plan_changed'
           AND recipient_id = '91a40003-0000-4000-8000-000000000003') THEN
        RAISE EXCEPTION 'the regional manager was not told the plan changed';
    END IF;

    -- The waiter was not, because a bill is not their business. Read as
    -- postgres, so this is an absence in the table and not an absence behind
    -- somebody else's RLS.
    IF EXISTS (
        SELECT FROM public.notifications
         WHERE organization_id = v_org AND kind = 'plan_changed'
           AND recipient_id = '91a40002-0000-4000-8000-000000000002') THEN
        RAISE EXCEPTION 'a waiter was told about the subscription';
    END IF;

    -- And neither was the person who did it.
    IF EXISTS (
        SELECT FROM public.notifications
         WHERE organization_id = v_org AND kind = 'plan_changed'
           AND recipient_id = '91a40001-0000-4000-8000-000000000001') THEN
        RAISE EXCEPTION 'the actor was notified of their own change';
    END IF;

    -- And the body names what went, not just that something did.
    IF NOT EXISTS (
        SELECT FROM public.notifications
         WHERE organization_id = v_org AND kind = 'plan_changed'
           AND body LIKE '%performance%') THEN
        RAISE EXCEPTION 'the notification does not say what was switched off';
    END IF;

    RAISE NOTICE 'OK 5: the owner was told, and told what went';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. An explicit plan change ends grandfathering.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_org uuid := '91a40000-0000-4000-8000-000000000000';
BEGIN
    -- Stand one up by hand: this tenant is younger than the backfill.
    UPDATE public.organization_modules
       SET enabled = true, grandfathered = true
     WHERE organization_id = v_org AND module_key = 'insights';

    IF NOT FOUND THEN
        INSERT INTO public.organization_modules
            (organization_id, module_key, enabled, grandfathered)
        VALUES (v_org, 'insights', true, true);
    END IF;

    -- While grandfathered, it runs despite the plan.
    IF NOT app.org_has_module(v_org, 'insights') THEN
        RAISE EXCEPTION 'a grandfathered module is not running';
    END IF;

    PERFORM app.change_plan(v_org, 'standard', 'moved up a little');

    IF EXISTS (SELECT FROM public.organization_modules
                WHERE organization_id = v_org AND grandfathered) THEN
        RAISE EXCEPTION 'grandfathering survived an explicit plan change';
    END IF;
    -- standard still does not reach insights, so it goes with the promise.
    IF app.org_has_module(v_org, 'insights') THEN
        RAISE EXCEPTION 'insights ran on a standard plan after grandfathering ended';
    END IF;

    RAISE NOTICE 'OK 6: an explicit plan change ends grandfathering';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. plan_tier moves only through the procedure — even for postgres, who owns
--    every table here and could otherwise do it with one UPDATE.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_org uuid := '91a40000-0000-4000-8000-000000000000';
BEGIN
    BEGIN
        UPDATE public.organizations SET plan_tier = 'enterprise' WHERE id = v_org;
        RAISE EXCEPTION 'plan_tier moved by direct UPDATE';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    IF (SELECT plan_tier FROM public.organizations WHERE id = v_org) <> 'standard' THEN
        RAISE EXCEPTION 'the plan moved anyway';
    END IF;

    -- The guard is on plan_tier, not on the table: everything else about an
    -- organization must still be editable, or this trigger has quietly frozen
    -- renaming a restaurant.
    UPDATE public.organizations SET name = 'Plan Test Org (renamed)' WHERE id = v_org;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the guard blocked an unrelated column';
    END IF;

    RAISE NOTICE 'OK 7: only change_plan moves a plan, and only a plan';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. The procedure refuses what it cannot make sense of.
-- ----------------------------------------------------------------------------
DO $$
DECLARE v_org uuid := '91a40000-0000-4000-8000-000000000000';
BEGIN
    BEGIN
        PERFORM app.change_plan(v_org, 'platinum', NULL);
        RAISE EXCEPTION 'a plan that does not exist was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;

    BEGIN
        PERFORM app.change_plan(v_org, 'standard', NULL);
        RAISE EXCEPTION 'moving to the plan it is already on was accepted';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;

    BEGIN
        PERFORM app.change_plan('00000000-0000-4000-8000-0000000000ff', 'premium', NULL);
        RAISE EXCEPTION 'a restaurant that does not exist changed plan';
    EXCEPTION WHEN no_data_found THEN NULL;
    END;

    RAISE NOTICE 'OK 8: unknown plans, no-op moves and unknown tenants are refused';
END;
$$;

ROLLBACK;

DO $$
BEGIN
    RAISE NOTICE 'plan_admin_verification.sql: all checks passed (rolled back)';
END;
$$;
