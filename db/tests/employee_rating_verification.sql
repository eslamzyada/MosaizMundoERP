-- ============================================================================
-- Employee rating verification (0027) — runs as mosaiz_app_user, switching
-- between the cogs fixture's CASHIER and BRANCH MANAGER identities.
--
-- Two claims carry this feature, and both are unusual enough to be worth
-- pinning hard:
--
--   * READS ARE GATED. Everywhere else a member of the organization may SELECT
--     what the organization holds. Here a cashier must not read ANY rating,
--     including their own. A test that only checked writes would pass against
--     a policy that had quietly lost its SELECT coverage.
--
--   * THE MONTH LOCKS. A closed month cannot be written or rewritten, so last
--     quarter's verdicts cannot be revised after seeing this quarter's numbers.
--
-- Run order: after sale_attribution_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. A manager records a judgement for the current month.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_id     uuid;
    v_score  smallint;
    v_by     uuid;
    v_month  date;
BEGIN
    INSERT INTO public.employee_ratings
        (organization_id, employee_id, rated_by, period_month, score, note)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            'c0570001-0000-4000-8000-000000000001',
            'c0570002-0000-4000-8000-000000000002',
            date_trunc('month', now())::date, 4, 'منضبط وسريع في الذروة')
    RETURNING id INTO v_id;

    SELECT score, rated_by, period_month INTO v_score, v_by, v_month
    FROM public.employee_ratings WHERE id = v_id;

    IF v_score <> 4 THEN
        RAISE EXCEPTION 'the score must be recorded as given, got %', v_score;
    END IF;
    IF v_by IS DISTINCT FROM 'c0570002-0000-4000-8000-000000000002'::uuid THEN
        RAISE EXCEPTION 'a rating must record who made it, got %', v_by;
    END IF;
    IF v_month <> date_trunc('month', now())::date THEN
        RAISE EXCEPTION 'the period must be the month start, got %', v_month;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. It is EDITABLE while its month is open. A first impression on the 3rd
--    should be revisable on the 28th.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_score smallint;
    v_rows  int;
BEGIN
    UPDATE public.employee_ratings
    SET score = 5, note = 'تحسّن واضح خلال الشهر'
    WHERE employee_id = 'c0570001-0000-4000-8000-000000000001'
      AND period_month = date_trunc('month', now())::date;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'the open month must be editable (updated % rows)', v_rows;
    END IF;

    SELECT score INTO v_score FROM public.employee_ratings
    WHERE employee_id = 'c0570001-0000-4000-8000-000000000001';
    IF v_score <> 5 THEN
        RAISE EXCEPTION 'the revision must stick, got %', v_score;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. ONE RATING PER PERSON PER MONTH. Without this, "Ahmed's July rating" has
--    no single answer and a trend line means nothing.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.employee_ratings
            (organization_id, employee_id, rated_by, period_month, score)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570001-0000-4000-8000-000000000001',
                'c0570002-0000-4000-8000-000000000002',
                date_trunc('month', now())::date, 2);
    EXCEPTION WHEN unique_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a second rating for the same person and month must be refused';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A CLOSED MONTH IS HISTORY — it can be neither written nor rewritten.
--    Both routes are covered: back-dating a new rating is the same act as
--    editing an old one.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    caught text;
BEGIN
    -- Back-dating a new rating into a closed month.
    caught := NULL;
    BEGIN
        INSERT INTO public.employee_ratings
            (organization_id, employee_id, rated_by, period_month, score)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570001-0000-4000-8000-000000000001',
                'c0570002-0000-4000-8000-000000000002',
                (date_trunc('month', now()) - interval '1 month')::date, 5);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '55000' THEN
        RAISE EXCEPTION 'back-dating into a closed month must raise 55000, got %',
            COALESCE(caught, 'nothing');
    END IF;

    -- Moving an open rating into another month.
    caught := NULL;
    BEGIN
        UPDATE public.employee_ratings
        SET period_month = (date_trunc('month', now()) - interval '1 month')::date
        WHERE employee_id = 'c0570001-0000-4000-8000-000000000001';
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '55000' THEN
        RAISE EXCEPTION 'moving a rating between months must raise 55000, got %',
            COALESCE(caught, 'nothing');
    END IF;

    -- And the future is a guess, not a judgement.
    caught := NULL;
    BEGIN
        INSERT INTO public.employee_ratings
            (organization_id, employee_id, rated_by, period_month, score)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570001-0000-4000-8000-000000000001',
                'c0570002-0000-4000-8000-000000000002',
                (date_trunc('month', now()) + interval '1 month')::date, 5);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS NULL THEN
        RAISE EXCEPTION 'rating a future month must be refused';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Nobody rates themselves.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.employee_ratings
            (organization_id, employee_id, rated_by, period_month, score)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570002-0000-4000-8000-000000000002',
                'c0570002-0000-4000-8000-000000000002',
                date_trunc('month', now())::date, 5);
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SELF-RATING: a manager awarded themselves a score';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. THE READ GATE — the assertion this feature turns on.
--
--    A cashier must read NOTHING, not even the rating that is about them. Note
--    the SHAPE: a RESTRICTIVE policy FILTERS rows rather than raising, so a
--    SELECT succeeds and returns nothing. Asserting on the row count is the
--    only way to catch this; a test that expected an exception would pass
--    against a policy that had been dropped entirely.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_visible int;
    v_own     int;
    v_wrote   int;
BEGIN
    SELECT count(*) INTO v_visible FROM public.employee_ratings;
    IF v_visible <> 0 THEN
        RAISE EXCEPTION
            'PRIVACY BREACH: a cashier can read % rating(s). Unlike every other '
            'table here, SELECT on employee_ratings is gated (0027)', v_visible;
    END IF;

    SELECT count(*) INTO v_own FROM public.employee_ratings
    WHERE employee_id = 'c0570001-0000-4000-8000-000000000001';
    IF v_own <> 0 THEN
        RAISE EXCEPTION 'a cashier can read their OWN rating; the chosen policy '
            'is that ratings are a management record, not feedback';
    END IF;

    -- And writing is refused too. The RESTRICTIVE policy filters the row, so
    -- this raises rather than silently inserting.
    BEGIN
        INSERT INTO public.employee_ratings
            (organization_id, employee_id, rated_by, period_month, score)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570002-0000-4000-8000-000000000002',
                'c0570001-0000-4000-8000-000000000001',
                date_trunc('month', now())::date, 1);
        RAISE EXCEPTION 'SECURITY HOLE: a cashier rated a manager';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;  -- expected
    END;

    -- Nor can they edit an existing one out of view: the policy filters it, so
    -- the UPDATE affects nothing rather than failing loudly.
    UPDATE public.employee_ratings SET score = 1;
    GET DIAGNOSTICS v_wrote = ROW_COUNT;
    IF v_wrote <> 0 THEN
        RAISE EXCEPTION 'a cashier edited % rating(s) they cannot even see', v_wrote;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. The manager can still see it — proving section 6 measured the gate and
--    not an empty table.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_visible int;
BEGIN
    SELECT count(*) INTO v_visible FROM public.employee_ratings;
    IF v_visible < 1 THEN
        RAISE EXCEPTION 'the manager must see the rating they wrote (got %)', v_visible;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Structural: a rating may never be deleted.
--
--    Removing one erases a judgement rather than revising it, and the FOR ALL
--    permissive policy would cover DELETE if the privilege were ever granted —
--    the trap 0014, 0019 and 0024 each had to step around.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF has_table_privilege('mosaiz_app_user', 'public.employee_ratings', 'DELETE') THEN
        RAISE EXCEPTION
            'DELETE has been granted on employee_ratings with no RESTRICTIVE '
            'delete gate; the FOR ALL permissive policy covers it, so ratings '
            'have become erasable';
    END IF;
END;
$$;

SELECT 'employee_rating_verification: all assertions passed' AS result;
