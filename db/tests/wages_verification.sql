-- ============================================================================
-- Verification: wages (0042)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--   f10c0007 cashier
--
-- Two properties, and they are the reason 0038 stopped short of this:
--
--   1. HISTORY DOES NOT MOVE. A raise today leaves last month's cost exactly
--      where it was. If that fails, payroll is fiction.
--   2. PAY IS CONFIDENTIAL, and the branch manager is the interesting case —
--      they run the floor and write the rota, and they still may not read what
--      a colleague earns.
--
-- Plus the one an audit trail cannot give you: nobody awards themselves a
-- raise, owner excepted.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'labour', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. A raise is a NEW ROW, and the old rate keeps applying to the old days.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_then numeric;
    v_now  numeric;
BEGIN
    INSERT INTO public.employee_wages
        (organization_id, user_id, hourly_rate, effective_from, set_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0001-0000-4000-8000-000000000001',
            30.00, current_date - 60,
            'f10c0004-0000-4000-8000-000000000004');

    -- The raise.
    INSERT INTO public.employee_wages
        (organization_id, user_id, hourly_rate, effective_from, set_by, note)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0001-0000-4000-8000-000000000001',
            45.00, current_date,
            'f10c0004-0000-4000-8000-000000000004', 'علاوة سنوية');

    v_then := app.wage_at('f10c0001-0000-4000-8000-000000000001', current_date - 30);
    v_now  := app.wage_at('f10c0001-0000-4000-8000-000000000001', current_date);

    IF v_then IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION 'THE RAISE REWROTE HISTORY — last month now reads % an hour', v_then;
    END IF;
    IF v_now IS DISTINCT FROM 45.00 THEN
        RAISE EXCEPTION 'the new rate is not in force today (%)', v_now;
    END IF;

    RAISE NOTICE 'OK 1: % an hour last month, % today', v_then, v_now;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Before anybody had a rate at all, the answer is UNKNOWN — not zero.
--
--    Zero is a number payroll would happily multiply by. Null is a question
--    somebody has to answer.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before numeric;
    v_never  numeric;
BEGIN
    v_before := app.wage_at('f10c0001-0000-4000-8000-000000000001', current_date - 90);
    IF v_before IS NOT NULL THEN
        RAISE EXCEPTION 'a rate existed before it was ever set (%)', v_before;
    END IF;

    v_never := app.wage_at('f10c0002-0000-4000-8000-000000000002', current_date);
    IF v_never IS NOT NULL THEN
        RAISE EXCEPTION 'somebody with no wage record has a rate (%)', v_never;
    END IF;

    RAISE NOTICE 'OK 2: no rate reads as unknown, never as free labour';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Two rates starting the same day is ambiguous, so it is refused.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.employee_wages
            (organization_id, user_id, hourly_rate, effective_from, set_by)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0001-0000-4000-8000-000000000001',
                99.00, current_date,
                'f10c0004-0000-4000-8000-000000000004');
        RAISE EXCEPTION 'two rates start on the same day';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    -- And a negative rate is not a rate.
    BEGIN
        INSERT INTO public.employee_wages
            (organization_id, user_id, hourly_rate, effective_from, set_by)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0002-0000-4000-8000-000000000002',
                -5.00, current_date,
                'f10c0004-0000-4000-8000-000000000004');
        RAISE EXCEPTION 'a negative hourly rate was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 3: one rate per day, and it is not negative';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. THE CONFIDENTIALITY ONE: the branch manager runs the floor and still may
--    not read what the waiter earns.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_seen int;
    v_rate numeric;
BEGIN
    SELECT count(*) INTO v_seen FROM public.employee_wages
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'the branch manager can read a colleague''s pay (% rows)', v_seen;
    END IF;

    -- ...and the costing function tells them the same thing, because it runs
    -- as them. Unknown, not a number they were not entitled to.
    v_rate := app.wage_at('f10c0001-0000-4000-8000-000000000001', current_date);
    IF v_rate IS NOT NULL THEN
        RAISE EXCEPTION 'wage_at leaked a rate to somebody who may not read it (%)', v_rate;
    END IF;

    RAISE NOTICE 'OK 4: hours yes, pay no — and the function agrees';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Your own pay is always yours to see.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_mine numeric;
    v_others int;
BEGIN
    v_mine := app.wage_at('f10c0001-0000-4000-8000-000000000001', current_date);
    IF v_mine IS DISTINCT FROM 45.00 THEN
        RAISE EXCEPTION 'a waiter cannot read their own rate (%)', v_mine;
    END IF;

    SELECT count(*) INTO v_others FROM public.employee_wages
     WHERE user_id <> 'f10c0001-0000-4000-8000-000000000001';
    IF v_others <> 0 THEN
        RAISE EXCEPTION 'a waiter can read % other people''s pay', v_others;
    END IF;

    RAISE NOTICE 'OK 5: own pay visible, everybody else''s not';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. The accountant reads everything and writes nothing. Payroll is their job;
--    deciding pay is not.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_accountant uuid := 'f10c0008-0000-4000-8000-000000000008';
BEGIN
    IF NOT EXISTS (SELECT FROM public.organization_memberships
                    WHERE user_id = v_accountant AND role = 'accountant' AND is_active) THEN
        RAISE EXCEPTION 'no accountant in the fixture — this section would be vacuous';
    END IF;
END;
$$;

SET app.current_user_id = 'f10c0008-0000-4000-8000-000000000008';

DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.employee_wages
     WHERE user_id = 'f10c0001-0000-4000-8000-000000000001';
    IF v_seen = 0 THEN
        RAISE EXCEPTION 'the accountant cannot read the pay they have to run';
    END IF;

    BEGIN
        INSERT INTO public.employee_wages
            (organization_id, user_id, hourly_rate, effective_from, set_by)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0002-0000-4000-8000-000000000002',
                50.00, current_date,
                'f10c0008-0000-4000-8000-000000000008');
        RAISE EXCEPTION 'the accountant set somebody''s pay';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 6: the accountant reads pay and does not decide it';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. THE ONE AN AUDIT TRAIL CANNOT GIVE YOU: nobody raises their own rate.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0005-0000-4000-8000-000000000005';

DO $$
BEGIN
    BEGIN
        INSERT INTO public.employee_wages
            (organization_id, user_id, hourly_rate, effective_from, set_by)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0005-0000-4000-8000-000000000005',
                500.00, current_date,
                'f10c0005-0000-4000-8000-000000000005');
        RAISE EXCEPTION 'THE REGIONAL MANAGER AWARDED THEMSELVES A RAISE';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- ...but they may set somebody else's, because that is their job.
    INSERT INTO public.employee_wages
        (organization_id, user_id, hourly_rate, effective_from, set_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0002-0000-4000-8000-000000000002',
            35.00, current_date,
            'f10c0005-0000-4000-8000-000000000005');

    RAISE NOTICE 'OK 7: not your own, but your team''s yes';
END;
$$;

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    -- The owner IS exempt: a single-owner restaurant has nobody else to ask,
    -- which is the same concession 0035 makes for the menu.
    INSERT INTO public.employee_wages
        (organization_id, user_id, hourly_rate, effective_from, set_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0004-0000-4000-8000-000000000004',
            120.00, current_date,
            'f10c0004-0000-4000-8000-000000000004');

    RAISE NOTICE 'OK 7b: the owner may record their own draw';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. A pay history is not deletable.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        DELETE FROM public.employee_wages
         WHERE user_id = 'f10c0001-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'a pay record was deleted';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- A missing GRANT and a policy refusal share a SQLSTATE, so this is the
    -- assertion that distinguishes them.
    IF has_table_privilege('mosaiz_app_user', 'public.employee_wages', 'DELETE') THEN
        RAISE EXCEPTION 'the application role can delete pay history';
    END IF;

    RAISE NOTICE 'OK 8: pay history is a record, not a draft';
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. Switching labour off stops new rates and keeps the old ones readable —
--    payroll for a month already worked still has to run.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before int;
    v_after  int;
BEGIN
    SELECT count(*) INTO v_before FROM public.employee_wages;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'labour', false);

    BEGIN
        INSERT INTO public.employee_wages
            (organization_id, user_id, hourly_rate, effective_from, set_by)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0003-0000-4000-8000-000000000003',
                40.00, current_date + 1,
                'f10c0004-0000-4000-8000-000000000004');
        RAISE EXCEPTION 'a rate was set with the module switched off';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    SELECT count(*) INTO v_after FROM public.employee_wages;
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'switching labour off changed the pay history (% -> %)',
            v_before, v_after;
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'labour', true);
    RAISE NOTICE 'OK 9: no new rates, % existing ones still readable', v_after;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. Cross-tenant: another restaurant's payroll is not ours.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.employee_wages
            (organization_id, user_id, hourly_rate, effective_from, set_by)
        VALUES ('f10c1000-0000-4000-8000-000000000000',
                'f10c0006-0000-4000-8000-000000000006',
                75.00, current_date,
                'f10c0004-0000-4000-8000-000000000004');
        RAISE EXCEPTION 'set a wage in another restaurant';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    IF EXISTS (SELECT FROM public.employee_wages
                WHERE organization_id <> 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'another restaurant''s pay is visible here';
    END IF;

    RAISE NOTICE 'OK 10: payroll stops at the tenant boundary';
END;
$$;

\echo 'wages_verification: all checks passed'
