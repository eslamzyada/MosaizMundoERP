-- ============================================================================
-- Verification: labour (0038)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--
-- The claims worth proving:
--
--   1. THE ONE THAT MATTERS: nobody writes their own hours. Not by INSERT,
--      not by UPDATE, not the manager, and least of all the person the record
--      is about. Payroll built on an editable record is payroll built on trust.
--   2. A correction is possible but never anonymous.
--   3. The clock cannot be in two states at once.
--   4. Hours are private to their subject and their managers.
--   5. The module gate holds even though the procedures are SECURITY DEFINER
--      and therefore bypass RLS entirely.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;

    -- labour ships switched OFF (0038): it is a new capability, not one the
    -- tenant was already using. Turning it on is the first thing any of this
    -- needs, and it exercises 0037's procedure on the way past.
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'labour', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. THE ONE THAT MATTERS: time_entries is not writable by the application.
--
--    Attempted as the OWNER. If the highest role cannot write an hour, nobody
--    can invent one.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.time_entries (organization_id, user_id, started_at, ended_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0004-0000-4000-8000-000000000004',
                now() - interval '9 hours', now());
        RAISE EXCEPTION 'THE OWNER WROTE AN HOUR DIRECTLY — payroll is fiction';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- A missing GRANT and a policy refusal raise the SAME SQLSTATE, so the
    -- block above passes either way. This is the assertion that distinguishes
    -- them, and it is the one that catches somebody "helpfully" granting
    -- INSERT later.
    IF has_table_privilege('mosaiz_app_user', 'public.time_entries', 'INSERT')
       OR has_table_privilege('mosaiz_app_user', 'public.time_entries', 'UPDATE')
       OR has_table_privilege('mosaiz_app_user', 'public.time_entries', 'DELETE') THEN
        RAISE EXCEPTION 'the application role can write time entries directly';
    END IF;

    RAISE NOTICE 'OK 1: hours cannot be written by the application at all';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. The clock works, and it is the server that decides what time it is.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_id      uuid;
    v_started timestamptz;
BEGIN
    v_id := app.clock_in();

    SELECT started_at INTO v_started FROM public.time_entries WHERE id = v_id;
    IF v_started IS NULL THEN
        RAISE EXCEPTION 'clocking in recorded nothing';
    END IF;
    -- Stamped from the server clock: within a second of now, not whatever a
    -- client might have offered.
    IF abs(EXTRACT(EPOCH FROM (now() - v_started))) > 5 THEN
        RAISE EXCEPTION 'the start time did not come from the server clock (%)', v_started;
    END IF;

    RAISE NOTICE 'OK 2: the waiter is clocked in at %', v_started;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. The clock cannot be in two states at once.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_open int;
BEGIN
    BEGIN
        PERFORM app.clock_in();
        RAISE EXCEPTION 'clocked in twice — a parallel working day is now open';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    SELECT count(*) INTO v_open FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001' AND ended_at IS NULL;
    IF v_open <> 1 THEN
        RAISE EXCEPTION 'expected exactly one open entry, found %', v_open;
    END IF;

    RAISE NOTICE 'OK 3: a second clock-in is refused, one entry still open';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Nobody edits their own hours — including by UPDATE on their own row,
--    which the own-row policy would otherwise permit.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id      uuid;
    v_touched int;
BEGIN
    SELECT id INTO v_id FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001' AND ended_at IS NULL;

    -- No UPDATE privilege at all, so this is a privilege error rather than a
    -- policy filter. The own-row policy is about READING; it is deliberately
    -- not what stops this.
    BEGIN
        UPDATE public.time_entries
           SET started_at = now() - interval '9 hours'
         WHERE id = v_id;
        RAISE EXCEPTION 'a waiter back-dated their own start time';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    SELECT count(*) INTO v_touched FROM public.time_entries
     WHERE id = v_id AND started_at < now() - interval '1 hour';
    IF v_touched <> 0 THEN
        RAISE EXCEPTION 'the start time moved despite the refusal';
    END IF;

    RAISE NOTICE 'OK 4: the subject of a record cannot edit it';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Clocking out closes it, and only the caller's own.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_minutes int;
BEGIN
    v_minutes := app.clock_out();
    IF v_minutes IS NULL OR v_minutes < 0 THEN
        RAISE EXCEPTION 'clock_out returned % minutes', v_minutes;
    END IF;

    IF EXISTS (SELECT FROM public.time_entries
                WHERE user_id = 'f10c0001-0000-4000-8000-000000000001'
                  AND ended_at IS NULL) THEN
        RAISE EXCEPTION 'the entry is still open after clocking out';
    END IF;

    -- And a second clock-out has nothing to close.
    BEGIN
        PERFORM app.clock_out();
        RAISE EXCEPTION 'clocked out twice';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    RAISE NOTICE 'OK 5: clocked out after % minutes', v_minutes;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A correction is a manager's act, and it is never anonymous.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id uuid;
BEGIN
    SELECT id INTO v_id FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001'
     ORDER BY started_at DESC LIMIT 1;

    -- The waiter cannot amend their own.
    BEGIN
        PERFORM app.amend_time_entry(v_id, now() - interval '9 hours', now(), 'نسيت التسجيل');
        RAISE EXCEPTION 'a waiter amended their own hours';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'OK 6: a worker cannot amend their own entry';
END;
$$;

SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_id     uuid;
    v_by     uuid;
    v_reason text;
BEGIN
    SELECT id INTO v_id FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001'
     ORDER BY started_at DESC LIMIT 1;

    -- An amendment with no reason is not an amendment, it is a rewrite.
    BEGIN
        PERFORM app.amend_time_entry(v_id, now() - interval '9 hours', now(), '  ');
        RAISE EXCEPTION 'an unexplained amendment was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    -- And it cannot end before it starts.
    BEGIN
        PERFORM app.amend_time_entry(v_id, now(), now() - interval '1 hour', 'خطأ');
        RAISE EXCEPTION 'a shift that ends before it starts was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    PERFORM app.amend_time_entry(v_id, now() - interval '9 hours', now(),
                                 'نسي تسجيل الانصراف، أُكمل يدويًا');

    SELECT amended_by, amendment_reason INTO v_by, v_reason
      FROM public.time_entries WHERE id = v_id;

    IF v_by IS DISTINCT FROM 'f10c0003-0000-4000-8000-000000000003' THEN
        RAISE EXCEPTION 'the amendment does not name who made it (%)', v_by;
    END IF;
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'the amendment kept no reason';
    END IF;

    RAISE NOTICE 'OK 6b: amended by %, because "%"', v_by, v_reason;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Hours are private to their subject and to management.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'the kitchen can read a waiter''s comings and goings (% rows)', v_seen;
    END IF;
    RAISE NOTICE 'OK 7: a colleague sees nothing';
END;
$$;

SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001';
    IF v_seen = 0 THEN
        RAISE EXCEPTION 'a manager cannot read the hours they are responsible for';
    END IF;
    RAISE NOTICE 'OK 7b: a manager sees % entries', v_seen;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. The rota: managers write it, everyone reads it, nobody is in two places.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_start timestamptz := date_trunc('hour', now()) + interval '1 day';
BEGIN
    INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0001-0000-4000-8000-000000000001',
            v_start, v_start + interval '8 hours',
            'f10c0003-0000-4000-8000-000000000003');

    -- Overlapping the same person is refused by the database, not by whoever
    -- remembered to check.
    BEGIN
        INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0001-0000-4000-8000-000000000001',
                v_start + interval '4 hours', v_start + interval '12 hours');
        RAISE EXCEPTION 'the same person was scheduled twice at once';
    EXCEPTION WHEN exclusion_violation THEN
        NULL;
    END;

    -- Back to back is fine — the range is half-open on purpose.
    INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0001-0000-4000-8000-000000000001',
            v_start + interval '8 hours', v_start + interval '14 hours');

    -- The shape constraints, asserted HERE rather than in negative_checks.sh:
    -- that file runs before any fixture enables labour, so 0037's module gate
    -- would refuse these inserts before the CHECKs were ever consulted, and
    -- the assertions would survive deleting the constraints.
    BEGIN
        INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0005-0000-4000-8000-000000000005',
                v_start, v_start - interval '1 hour');
        RAISE EXCEPTION 'a shift that ends before it starts was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0005-0000-4000-8000-000000000005',
                v_start, v_start + interval '3 days');
        RAISE EXCEPTION 'a three-day shift was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 8: overlaps refused, consecutive shifts allowed, shape enforced';
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_seen int;
BEGIN
    -- The rota is a sheet of paper on the wall.
    SELECT count(*) INTO v_seen FROM public.shifts
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_seen = 0 THEN
        RAISE EXCEPTION 'a waiter cannot read the rota they are on';
    END IF;

    -- But not one they may write.
    BEGIN
        INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0001-0000-4000-8000-000000000001',
                now() + interval '10 days', now() + interval '10 days 4 hours');
        RAISE EXCEPTION 'a waiter scheduled themselves';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 8b: the rota is readable by all, writable by managers';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8c. You may clock in against YOUR shift, not somebody else's.
--
--     The rota is readable by everyone, which is what makes this reachable: a
--     waiter can see the kitchen's shift id and could otherwise attach their
--     own hours to it.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_start timestamptz := date_trunc('hour', now()) + interval '3 days';
BEGIN
    INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0002-0000-4000-8000-000000000002',
            v_start, v_start + interval '8 hours',
            'f10c0003-0000-4000-8000-000000000003');
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_kitchen_shift uuid;
    v_open          int;
BEGIN
    SELECT id INTO v_kitchen_shift FROM public.shifts
     WHERE user_id = 'f10c0002-0000-4000-8000-000000000002'
     ORDER BY starts_at DESC LIMIT 1;

    IF v_kitchen_shift IS NULL THEN
        RAISE EXCEPTION 'no foreign shift to attempt — this section would be vacuous';
    END IF;

    BEGIN
        PERFORM app.clock_in(v_kitchen_shift);
        RAISE EXCEPTION 'clocked in against somebody else''s shift';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- And the refusal left no half-open entry behind.
    SELECT count(*) INTO v_open FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001' AND ended_at IS NULL;
    IF v_open <> 0 THEN
        RAISE EXCEPTION 'the refused clock-in still opened an entry';
    END IF;

    RAISE NOTICE 'OK 8c: a shift is only clockable by the person it belongs to';
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. The module gate holds through SECURITY DEFINER.
--
--    This is the section that would be missing if somebody assumed 0037's
--    RESTRICTIVE policies covered everything: they do not apply inside a
--    SECURITY DEFINER function, which runs as the owner.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'labour', false);
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_before int;
    v_after  int;
BEGIN
    SELECT count(*) INTO v_before FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001';

    BEGIN
        PERFORM app.clock_in();
        RAISE EXCEPTION 'clocked in through a module that is switched off';
    EXCEPTION WHEN feature_not_supported THEN
        NULL;
    END;

    -- ...and the hours already worked are still there to be paid.
    SELECT count(*) INTO v_after FROM public.time_entries
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001';
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'switching labour off changed the hours already worked (% -> %)',
            v_before, v_after;
    END IF;

    RAISE NOTICE 'OK 9: the clock stops, the record stands (% entries)', v_after;
END;
$$;

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'labour', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. Cross-tenant: another restaurant's rota is not ours to write.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    -- The solo restaurant from floor_roles_fixture, as a LITERAL: looking one
    -- up by slug would read through RLS, find nothing, and assert against NULL.
    BEGIN
        INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at)
        VALUES ('f10c1000-0000-4000-8000-000000000000',
                'f10c0006-0000-4000-8000-000000000006',
                now() + interval '2 days', now() + interval '2 days 6 hours');
        RAISE EXCEPTION 'scheduled somebody in another restaurant';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 10: another restaurant''s rota is not ours';
END;
$$;

\echo 'labour_verification: all checks passed'
