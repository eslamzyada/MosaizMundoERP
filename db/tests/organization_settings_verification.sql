-- ============================================================================
-- Verification: who may change what the restaurant IS (0048)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization      f10c0001 waiter    f10c0002 kitchen
--   f10c0003 branch manager    f10c0004 owner     f10c0005 regional manager
--
-- Until 0048 `organizations` carried ONE permissive FOR ALL policy, so any
-- member could rename the restaurant, change its slug, deactivate it, or
-- DELETE the row — cascading away every order, payment, shift and stocktake.
-- Nothing in the product ever did it. It was reachable and unused, which is
-- the shape that survives review.
--
-- The claims, and the two halves matter equally:
--
--   1. READING stays open to everybody. A waiter's screen shows the
--      restaurant's name; a gate that closed reading would take the product
--      dark for every role below owner. This is asserted FIRST because it is
--      the one a careless tightening breaks.
--   2. Writing is the owner's alone — not the branch manager's, not the
--      regional manager's, and certainly not the waiter's.
--   3. Deleting a restaurant is not something the API can do at all.
--   4. plan_tier still moves only through app.change_plan (0044) — now that
--      an owner CAN update the row, that guard is load-bearing in a way it
--      was not before.
-- ============================================================================

\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. Every role can still READ its own restaurant.
--
--    Checked across four roles rather than one, because "the owner can read
--    it" would pass with the policy closed to everybody else.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_role  text;
    v_id    text;
    v_seen  integer;
BEGIN
    FOREACH v_id IN ARRAY ARRAY[
        'f10c0001-0000-4000-8000-000000000001',   -- waiter
        'f10c0002-0000-4000-8000-000000000002',   -- kitchen
        'f10c0003-0000-4000-8000-000000000003',   -- branch manager
        'f10c0004-0000-4000-8000-000000000004'    -- owner
    ] LOOP
        PERFORM set_config('app.current_user_id', v_id, false);

        SELECT count(*) INTO v_seen FROM public.organizations
         WHERE id = 'f10c0000-0000-4000-8000-000000000000';

        IF v_seen <> 1 THEN
            RAISE EXCEPTION 'identity % cannot read its own restaurant', v_id;
        END IF;
    END LOOP;

    RAISE NOTICE 'OK 1: every role still reads the restaurant it works in';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A waiter cannot rename it. Nor a kitchen user, nor a branch manager.
--
--    Each attempt is checked for having changed NOTHING, because an UPDATE
--    filtered to zero rows raises no error — it simply does nothing, and a
--    test that only watched for an exception would pass either way.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id     text;
    v_before text;
    v_after  text;
BEGIN
    PERFORM set_config('app.current_user_id',
                       'f10c0004-0000-4000-8000-000000000004', false);
    SELECT name INTO v_before FROM public.organizations
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';

    FOREACH v_id IN ARRAY ARRAY[
        'f10c0001-0000-4000-8000-000000000001',   -- waiter
        'f10c0002-0000-4000-8000-000000000002',   -- kitchen
        'f10c0003-0000-4000-8000-000000000003',   -- branch manager
        'f10c0005-0000-4000-8000-000000000005'    -- regional manager
    ] LOOP
        PERFORM set_config('app.current_user_id', v_id, false);

        BEGIN
            UPDATE public.organizations
               SET name = 'مطعم غيّرته أنا'
             WHERE id = 'f10c0000-0000-4000-8000-000000000000';
        EXCEPTION
            WHEN insufficient_privilege THEN NULL;
        END;

        PERFORM set_config('app.current_user_id',
                           'f10c0004-0000-4000-8000-000000000004', false);
        SELECT name INTO v_after FROM public.organizations
         WHERE id = 'f10c0000-0000-4000-8000-000000000000';

        IF v_after IS DISTINCT FROM v_before THEN
            RAISE EXCEPTION 'identity % renamed the restaurant to %', v_id, v_after;
        END IF;
    END LOOP;

    RAISE NOTICE 'OK 2: nobody below an owner can rename the restaurant';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. The owner CAN.
--
--    Without this, a policy that refused everybody would pass check 2 — and
--    would have left the restaurant unable to correct its own name.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before text;
    v_after  text;
BEGIN
    PERFORM set_config('app.current_user_id',
                       'f10c0004-0000-4000-8000-000000000004', false);

    SELECT name INTO v_before FROM public.organizations
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';

    UPDATE public.organizations
       SET name = v_before || ' ✎'
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';

    SELECT name INTO v_after FROM public.organizations
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';

    IF v_after <> v_before || ' ✎' THEN
        RAISE EXCEPTION 'the owner could not rename their own restaurant';
    END IF;

    -- Put it back, so the suite leaves the fixture as it found it.
    UPDATE public.organizations SET name = v_before
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';

    RAISE NOTICE 'OK 3: the owner can, which is what makes check 2 mean something';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Nobody deletes a restaurant through the API — including the owner.
--
--    Closing one is is_active = false, which keeps every record somebody may
--    later be asked to produce.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_still integer;
BEGIN
    PERFORM set_config('app.current_user_id',
                       'f10c0004-0000-4000-8000-000000000004', false);

    BEGIN
        DELETE FROM public.organizations
         WHERE id = 'f10c0000-0000-4000-8000-000000000000';
        RAISE EXCEPTION 'an owner deleted the restaurant, and everything in it';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    SELECT count(*) INTO v_still FROM public.organizations
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_still <> 1 THEN
        RAISE EXCEPTION 'the restaurant is gone';
    END IF;

    -- Asserted at the PRIVILEGE level too: a policy added later by somebody
    -- who did not read the migration would re-open this, and the missing GRANT
    -- is what survives that.
    IF has_table_privilege('mosaiz_app_user', 'public.organizations', 'DELETE') THEN
        RAISE EXCEPTION 'the app role still holds DELETE on organizations';
    END IF;

    -- And closing one IS available, or the refusal above would leave a
    -- restaurant unable to stop trading.
    UPDATE public.organizations SET is_active = is_active
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'an owner cannot set is_active either';
    END IF;

    RAISE NOTICE 'OK 4: a restaurant is closed, never deleted';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. And an owner still cannot move their own plan.
--
--    0044's trigger was written when NOBODY could update this row through a
--    role gate. Now an owner can, so this is the check that keeps a free
--    upgrade from being one UPDATE away.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_plan text;
BEGIN
    PERFORM set_config('app.current_user_id',
                       'f10c0004-0000-4000-8000-000000000004', false);

    SELECT plan_tier INTO v_plan FROM public.organizations
     WHERE id = 'f10c0000-0000-4000-8000-000000000000';

    -- A plan it is NOT already on. 0044's guard fires on
    -- `NEW.plan_tier IS DISTINCT FROM OLD.plan_tier`, so setting the current
    -- value is a no-op the trigger correctly ignores — and a test that did
    -- that would report the guard missing when it was working, or worse, pass
    -- when it had been removed.
    BEGIN
        UPDATE public.organizations
           SET plan_tier = CASE WHEN v_plan = 'enterprise' THEN 'basic' ELSE 'enterprise' END
         WHERE id = 'f10c0000-0000-4000-8000-000000000000';
        RAISE EXCEPTION 'an owner promoted their own restaurant';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    IF (SELECT plan_tier FROM public.organizations
         WHERE id = 'f10c0000-0000-4000-8000-000000000000') <> v_plan THEN
        RAISE EXCEPTION 'the plan moved';
    END IF;

    RAISE NOTICE 'OK 5: an owner may edit the restaurant, but not what it pays';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. And none of it reaches another restaurant.
--
--    Addressed by the literal id of the solo restaurant, from OUR identity.
--    A lookup would find nothing under RLS and leave the UPDATE matching zero
--    rows for the wrong reason entirely.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before text;
    v_after  text;
BEGIN
    -- Read as somebody who belongs to it, so there is a value to compare.
    PERFORM set_config('app.current_user_id',
                       'f10c0006-0000-4000-8000-000000000006', false);
    SELECT name INTO v_before FROM public.organizations
     WHERE id = 'f10c1000-0000-4000-8000-000000000000';

    IF v_before IS NULL THEN
        RAISE EXCEPTION 'fixture: the solo restaurant is missing';
    END IF;

    -- Now as OUR owner, who is an owner — of a different restaurant.
    PERFORM set_config('app.current_user_id',
                       'f10c0004-0000-4000-8000-000000000004', false);
    BEGIN
        UPDATE public.organizations SET name = 'استوليت عليه'
         WHERE id = 'f10c1000-0000-4000-8000-000000000000';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    PERFORM set_config('app.current_user_id',
                       'f10c0006-0000-4000-8000-000000000006', false);
    SELECT name INTO v_after FROM public.organizations
     WHERE id = 'f10c1000-0000-4000-8000-000000000000';

    IF v_after IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION 'an owner renamed ANOTHER restaurant: % -> %', v_before, v_after;
    END IF;

    RAISE NOTICE 'OK 6: being an owner somewhere is not being an owner everywhere';
END;
$$;

\echo 'organization_settings_verification: all checks passed'
