-- ============================================================================
-- Verification: plans as a ceiling on modules (0044)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c2000 CI Basic Bistro    f10c0009 its owner
--
-- Deliberately NOT the main floor restaurant, which the fixture provisions at
-- enterprise so the other fifteen suites can test what they were written to
-- test. This one is on `basic` and exists for no other reason: a ceiling
-- nobody stands under is not a ceiling anybody has tested.
--
-- What is worth proving:
--
--   1. The plan stops an ENABLE, and says so in its own words. "Upgrade" and
--      "switch it on" are different instructions; a caller that cannot tell
--      them apart sends people to the wrong screen, and one of those screens
--      asks for money.
--   2. The plan never stops a DISABLE. A ceiling, not an assignment.
--   3. The catalogue default cannot outrun the plan, or a tenant that simply
--      never opened the الوحدات screen gets the premium shelf for nothing.
--   4. A tenant cannot promote itself — not through set_module, not through
--      change_plan, and not by writing plan_tier directly.
--   5. Grandfathering lets a kept promise through the same gate that refuses
--      everyone else.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0009-0000-4000-8000-000000000009';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c2000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;
    IF (SELECT plan_tier FROM public.organizations
         WHERE id = 'f10c2000-0000-4000-8000-000000000000') <> 'basic' THEN
        RAISE EXCEPTION 'this suite assumes the fixture tenant is on basic';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. The matrix is data, and it is the matrix we think it is.
--
--    Asserted rather than assumed, because everything below is only meaningful
--    if `insights` really is above `basic` and `inventory` really is not.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := 'f10c2000-0000-4000-8000-000000000000';
BEGIN
    IF NOT app.plan_includes(v_org, 'inventory') THEN
        RAISE EXCEPTION 'basic does not reach inventory — the core is behind a paywall';
    END IF;
    IF app.plan_includes(v_org, 'insights') THEN
        RAISE EXCEPTION 'basic reaches insights, so nothing below tests a ceiling';
    END IF;
    IF app.plan_includes(v_org, 'menu_approval') THEN
        RAISE EXCEPTION 'basic reaches menu_approval';
    END IF;

    -- Fail closed. A plan nobody recognises is worth the floor, never the
    -- benefit of the doubt.
    IF app.plan_rank('gold-plated') <> app.plan_rank('basic') THEN
        RAISE EXCEPTION 'an unknown plan does not rank as basic';
    END IF;
    IF app.plan_rank('enterprise') <= app.plan_rank('premium')
       OR app.plan_rank('premium') <= app.plan_rank('standard')
       OR app.plan_rank('standard') <= app.plan_rank('basic') THEN
        RAISE EXCEPTION 'the plans are not in order';
    END IF;

    -- An organization that does not exist is entitled to nothing, rather than
    -- to everything by way of a NULL that COALESCEs the wrong way.
    IF app.plan_includes('00000000-0000-4000-8000-0000000000ff', 'inventory') THEN
        RAISE EXCEPTION 'a non-existent organization is entitled to inventory';
    END IF;

    RAISE NOTICE 'OK 1: the matrix is ordered, fails closed, and gates above basic';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. The default cannot outrun the plan.
--
--    `insights` is default_enabled, and this tenant has never written a row
--    for it. Under 0037 alone that means "on". It must not.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := 'f10c2000-0000-4000-8000-000000000000';
BEGIN
    IF EXISTS (SELECT FROM public.organization_modules
                WHERE organization_id = v_org AND module_key = 'insights') THEN
        RAISE EXCEPTION 'this check needs insights to have NO row, and it has one';
    END IF;
    IF NOT (SELECT default_enabled FROM public.modules WHERE key = 'insights') THEN
        RAISE EXCEPTION 'this check needs insights to be default_enabled, and it is not';
    END IF;

    IF app.org_has_module(v_org, 'insights') THEN
        RAISE EXCEPTION 'a basic tenant runs insights on the catalogue default alone';
    END IF;

    -- And the same fallback still works UNDER the ceiling, which is the half
    -- 0037 added it for: a module shipped later must not switch itself off for
    -- everybody on the morning it lands.
    IF NOT app.org_has_module(v_org, 'inventory') THEN
        RAISE EXCEPTION 'the default stopped working for a module the plan does reach';
    END IF;

    RAISE NOTICE 'OK 2: absent means default AND entitled, not default alone';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. The gate: an owner, doing everything right, still cannot switch on what
--    the plan does not reach — and is told which plan it needs.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_state text;
    v_msg   text;
BEGIN
    BEGIN
        PERFORM app.set_module('f10c2000-0000-4000-8000-000000000000', 'insights', true);
        RAISE EXCEPTION 'a basic tenant switched on insights';
    EXCEPTION
        WHEN SQLSTATE 'MZ402' THEN
            GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
            -- The message has to name the plan, because "no" without a price
            -- is not an answer anybody can act on.
            IF v_msg NOT LIKE '%premium%' THEN
                RAISE EXCEPTION 'the refusal does not name the plan needed: %', v_msg;
            END IF;
    END;

    -- And it must be ITS OWN code. 0A000 already means "that module is off",
    -- which is a switch away; this one is money away. An API that maps both to
    -- 403 sends the owner to a toggle that will not help.
    BEGIN
        PERFORM app.set_module('f10c2000-0000-4000-8000-000000000000', 'menu_approval', true);
        RAISE EXCEPTION 'a basic tenant switched on menu_approval';
    EXCEPTION
        WHEN SQLSTATE 'MZ402' THEN NULL;
        WHEN feature_not_supported THEN
            RAISE EXCEPTION 'entitlement refused with 0A000, which is indistinguishable from a module being off';
    END;

    RAISE NOTICE 'OK 3: the ceiling refuses with MZ402 and names the plan';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A ceiling, not an assignment. Switching OFF is always allowed, at any
--    tier, for anything — including something the plan does reach.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := 'f10c2000-0000-4000-8000-000000000000';
BEGIN
    PERFORM app.set_module(v_org, 'printers', false);
    IF app.org_has_module(v_org, 'printers') THEN
        RAISE EXCEPTION 'a tenant could not switch off a module its plan includes';
    END IF;

    -- Back on again: that one IS within the plan, so the gate must let it
    -- through. A ceiling that refused everything would pass check 3 as well.
    PERFORM app.set_module(v_org, 'printers', true);
    IF NOT app.org_has_module(v_org, 'printers') THEN
        RAISE EXCEPTION 'a tenant could not switch a module its plan includes back on';
    END IF;

    RAISE NOTICE 'OK 4: off is always allowed, and on is allowed within the plan';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Grandfathering: a kept promise passes the same gate that just refused.
--
--    Built here rather than relied on from the backfill, because the fixture
--    tenant is younger than the migration. The row is written as postgres in
--    plan_admin_verification.sql; this only proves the gate honours it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := 'f10c2000-0000-4000-8000-000000000000';
BEGIN
    -- Not a skip. A suite that steps over its own subject when the fixture is
    -- incomplete reports success for having tested nothing, which is the one
    -- outcome worse than failing.
    IF NOT EXISTS (SELECT FROM public.organization_modules
                    WHERE organization_id = v_org
                      AND module_key = 'exports' AND grandfathered) THEN
        RAISE EXCEPTION 'fixture missing: no grandfathered exports row to test';
    END IF;

    IF app.plan_includes(v_org, 'exports') THEN
        RAISE EXCEPTION 'exports is within basic, so this proves nothing';
    END IF;

    PERFORM app.set_module(v_org, 'exports', false);
    PERFORM app.set_module(v_org, 'exports', true);

    IF NOT app.org_has_module(v_org, 'exports') THEN
        RAISE EXCEPTION 'a grandfathered module could not be switched back on';
    END IF;

    RAISE NOTICE 'OK 5: grandfathering survives a round trip through the gate';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A tenant cannot promote itself. Three routes, all shut.
--
--    This is the one that carries revenue: an owner who can reach any of these
--    gets the whole product for the price of the cheapest plan.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org    uuid := 'f10c2000-0000-4000-8000-000000000000';
    v_caught boolean := false;
BEGIN
    -- (a) Writing the column directly.
    --
    --     organizations carries a PERMISSIVE `FOR ALL` policy, so a member may
    --     update their own restaurant's row — that is how renaming works. The
    --     trigger is therefore the ONLY thing standing between an owner and a
    --     free upgrade, which is why this insists on the trigger's refusal
    --     rather than accepting a zero-row update. If a future policy change
    --     made the UPDATE match nothing, this check would go quiet while the
    --     guard it exists for rotted.
    BEGIN
        UPDATE public.organizations SET plan_tier = 'enterprise' WHERE id = v_org;
    EXCEPTION
        WHEN insufficient_privilege THEN v_caught := true;
    END;

    IF NOT v_caught THEN
        RAISE EXCEPTION 'the plan_tier guard did not refuse a direct UPDATE';
    END IF;

    -- And the guard is on the COLUMN, not the table: renaming must still work,
    -- or this has quietly frozen every other edit to an organization.
    UPDATE public.organizations SET name = name WHERE id = v_org;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the guard blocked an unrelated column';
    END IF;

    -- (b) Calling the procedure. Not granted to the app role at all.
    BEGIN
        PERFORM app.change_plan(v_org, 'enterprise', 'help yourself');
        RAISE EXCEPTION 'the application role executed app.change_plan';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
        WHEN undefined_function THEN NULL;
    END;

    -- (c) Writing the audit trail, which would be the next thing to forge.
    BEGIN
        INSERT INTO public.plan_changes (organization_id, from_plan, to_plan)
        VALUES (v_org, 'basic', 'enterprise');
        RAISE EXCEPTION 'the application role wrote a plan change';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    IF (SELECT plan_tier FROM public.organizations WHERE id = v_org) <> 'basic' THEN
        RAISE EXCEPTION 'the plan moved after all of that';
    END IF;

    RAISE NOTICE 'OK 6: no self-promotion by column, by procedure, or by audit row';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Reading its own history is allowed — it is the tenant's own bill.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    PERFORM count(*) FROM public.plan_changes;

    IF NOT has_table_privilege('mosaiz_app_user', 'public.plan_changes', 'SELECT') THEN
        RAISE EXCEPTION 'the app role cannot read plan history';
    END IF;
    IF has_table_privilege('mosaiz_app_user', 'public.plan_changes', 'INSERT')
       OR has_table_privilege('mosaiz_app_user', 'public.plan_changes', 'UPDATE')
       OR has_table_privilege('mosaiz_app_user', 'public.plan_changes', 'DELETE') THEN
        -- Checked at the GRANT level as well as the policy level, because a
        -- missing policy and a missing privilege both raise 42501 and only one
        -- of them survives somebody adding a permissive policy later.
        RAISE EXCEPTION 'the app role holds a write privilege on plan_changes';
    END IF;

    -- The other half of the same guarantee, and the more dangerous one:
    -- `grandfathered` is what lets a module through the ceiling, so a tenant
    -- able to write it could unlock the whole catalogue with one UPDATE.
    -- set_module never sets it, but the reason it CANNOT be set is that the
    -- privilege was never granted — assert the privilege, not the procedure.
    IF has_table_privilege('mosaiz_app_user', 'public.organization_modules', 'UPDATE')
       OR has_table_privilege('mosaiz_app_user', 'public.organization_modules', 'INSERT') THEN
        RAISE EXCEPTION 'the app role can write organization_modules directly, so it can grandfather itself';
    END IF;

    RAISE NOTICE 'OK 7: plan history is readable, and entitlement is not writable';
END;
$$;

-- Leave the fixture as it was found.
SELECT app.set_module('f10c2000-0000-4000-8000-000000000000', 'printers', true);

DO $$
BEGIN
    RAISE NOTICE 'plan_verification.sql: all checks passed';
END;
$$;
