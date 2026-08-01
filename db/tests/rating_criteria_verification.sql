-- ============================================================================
-- Verification: rating criteria and per-criterion scores (0033)
--
-- Runs as mosaiz_app_user, so every statement is subject to RLS exactly as the
-- API is. Identities come from cogs_fixture.sql:
--
--   c0570000  the organization        c0570001  cashier
--   c0570002  branch manager          c0570003  accountant
--
-- Fixed uuids rather than lookups by role: a SELECT that finds nobody makes
-- every assertion after it vacuously true, and the suite would pass by testing
-- nothing at all.
--
-- What this is looking for, in order of how quietly it would fail:
--
--   1. The rubric readable by a cashier while the SCORES are not. Wrong in
--      either direction and nothing looks broken — one way the review sheet is
--      empty for the person being reviewed, the other way a till operator reads
--      their colleagues' verdicts.
--   2. A score pointing at another restaurant's criterion. RLS only HIDES that
--      row; a SECURITY DEFINER procedure or a script runs outside RLS, and only
--      the composite foreign key actually refuses it.
--   3. The month lock applying here too. It reuses 0027's function, and a
--      trigger that was never attached looks identical to one that was, until
--      somebody back-dates a review.
--
-- NOT TESTED HERE, and stated rather than implied: the migration's backfill
-- loop over pre-existing organizations. In a clean CI database no organization
-- exists before 0033 runs, so the loop does nothing and cannot be observed. It
-- matters only to databases that predate this migration.
-- ============================================================================

\set ON_ERROR_STOP on

\set org        '''c0570000-0000-4000-8000-000000000000'''
\set cashier    '''c0570001-0000-4000-8000-000000000001'''
\set manager    '''c0570002-0000-4000-8000-000000000002'''
\set employee   '''c0570003-0000-4000-8000-000000000003'''

-- ----------------------------------------------------------------------------
-- 0. The fixture is really there. Everything below is meaningless without it.
--
--    The identity is bound FIRST. This guard reads through RLS like everything
--    else here, so running it as nobody reports the organization missing when
--    it is sitting right there — a false alarm that looks exactly like a real
--    one.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'c0570000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run cogs_fixture.sql first';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. An organization created AFTER this migration has a rubric already.
--
--    cogs_fixture ran as postgres after every migration, so these five rows can
--    only have come from the AFTER INSERT trigger. Nobody wrote them by hand
--    and no controller was involved.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_count int;
BEGIN
    SELECT count(*) INTO v_count FROM public.rating_criteria
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';

    IF v_count <> 5 THEN
        RAISE EXCEPTION 'expected 5 seeded criteria, found %', v_count;
    END IF;

    -- Ordinary rows, not protected ones: the point of seeding is to give the
    -- custom criteria something to sit beside, not to create a locked set.
    UPDATE public.rating_criteria
       SET name = name || ' (معدّل)'
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
       AND sort_order = 1;

    UPDATE public.rating_criteria
       SET name = replace(name, ' (معدّل)', '')
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
       AND sort_order = 1;

    RAISE NOTICE 'OK 1: a new organization is seeded with 5 editable criteria';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A manager adds one of their own, beside the seeded ones.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id    uuid;
    v_total int;
BEGIN
    INSERT INTO public.rating_criteria
        (organization_id, name, description, weight, sort_order)
    VALUES ('c0570000-0000-4000-8000-000000000000', 'إتقان تحضير المشاوي',
            'الالتزام بدرجة النضج المطلوبة', 2.5, 6)
    RETURNING id INTO v_id;

    SELECT count(*) INTO v_total FROM public.rating_criteria
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
    IF v_total <> 6 THEN
        RAISE EXCEPTION 'expected 6 criteria after adding one, found %', v_total;
    END IF;

    RAISE NOTICE 'OK 2: a custom criterion sits beside the seeded five (%)', v_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. THE READ SPLIT: the cashier may read the rubric, never the scores.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_criterion uuid;
    v_seen      int;
BEGIN
    SELECT id INTO v_criterion FROM public.rating_criteria
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
     ORDER BY sort_order LIMIT 1;

    INSERT INTO public.employee_criterion_scores
        (organization_id, employee_id, rated_by, criterion_id, period_month, score, note)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            'c0570003-0000-4000-8000-000000000003',
            'c0570002-0000-4000-8000-000000000002',
            v_criterion, date_trunc('month', now())::date, 4, 'تحسّن واضح هذا الشهر')
    ON CONFLICT (organization_id, employee_id, period_month, criterion_id)
    DO UPDATE SET score = 4;

    -- The row exists for an administrator. Without this, "the cashier sees
    -- nothing" is true of a table that is simply empty.
    SELECT count(*) INTO v_seen FROM public.employee_criterion_scores
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
    IF v_seen = 0 THEN
        RAISE EXCEPTION 'the score was not written, so hiding it proves nothing';
    END IF;
END;
$$;

SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_criteria int;
    v_scores   int;
BEGIN
    SELECT count(*) INTO v_criteria FROM public.rating_criteria
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
    IF v_criteria < 5 THEN
        RAISE EXCEPTION 'a cashier sees % criteria; the rubric must be readable by the people held to it', v_criteria;
    END IF;

    SELECT count(*) INTO v_scores FROM public.employee_criterion_scores;
    IF v_scores <> 0 THEN
        RAISE EXCEPTION 'a cashier can read % criterion scores; SELECT must be gated', v_scores;
    END IF;

    RAISE NOTICE 'OK 3: rubric readable (% rows), scores hidden', v_criteria;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A cashier cannot change the rubric, and cannot score anybody.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_state text;
BEGIN
    BEGIN
        INSERT INTO public.rating_criteria (organization_id, name)
        VALUES ('c0570000-0000-4000-8000-000000000000', 'معيار من الكاشير');
        RAISE EXCEPTION 'a cashier added a criterion';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        UPDATE public.rating_criteria SET weight = 9
         WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
        -- An UPDATE the policy refuses matches zero rows rather than raising,
        -- so silence here is also a pass — what must not happen is a change.
        IF EXISTS (SELECT FROM public.rating_criteria
                    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
                      AND weight = 9) THEN
            RAISE EXCEPTION 'a cashier reweighted a criterion';
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        DELETE FROM public.rating_criteria
         WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
        IF NOT EXISTS (SELECT FROM public.rating_criteria
                        WHERE organization_id = 'c0570000-0000-4000-8000-000000000000') THEN
            RAISE EXCEPTION 'a cashier deleted the whole rubric';
        END IF;
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 4: a cashier can read the rubric and change none of it';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. The month lock reaches the new table.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_criterion uuid;
BEGIN
    SELECT id INTO v_criterion FROM public.rating_criteria
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
     ORDER BY sort_order LIMIT 1;

    BEGIN
        INSERT INTO public.employee_criterion_scores
            (organization_id, employee_id, rated_by, criterion_id, period_month, score)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570003-0000-4000-8000-000000000003',
                'c0570002-0000-4000-8000-000000000002',
                v_criterion,
                (date_trunc('month', now()) - interval '1 month')::date, 5);
        RAISE EXCEPTION 'a closed month accepted a new score';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    RAISE NOTICE 'OK 5: last month is closed to the criterion scores too';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A criterion that has been scored cannot be deleted — it is retired.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_criterion uuid;
BEGIN
    SELECT criterion_id INTO v_criterion FROM public.employee_criterion_scores
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000' LIMIT 1;

    BEGIN
        DELETE FROM public.rating_criteria WHERE id = v_criterion;
        RAISE EXCEPTION 'deleting a scored criterion was allowed, rewriting a finished review';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    -- Retiring it is the supported move, and it keeps the history.
    UPDATE public.rating_criteria SET is_active = false WHERE id = v_criterion;
    IF NOT EXISTS (SELECT FROM public.employee_criterion_scores
                    WHERE criterion_id = v_criterion) THEN
        RAISE EXCEPTION 'retiring a criterion took its scores with it';
    END IF;
    UPDATE public.rating_criteria SET is_active = true WHERE id = v_criterion;

    RAISE NOTICE 'OK 6: a scored criterion is retired, never deleted';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. An UNSCORED criterion can be removed — a typo this morning is not history.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO public.rating_criteria (organization_id, name, sort_order)
    VALUES ('c0570000-0000-4000-8000-000000000000', 'خطأ مطبعي', 99)
    RETURNING id INTO v_id;

    DELETE FROM public.rating_criteria WHERE id = v_id;

    IF EXISTS (SELECT FROM public.rating_criteria WHERE id = v_id) THEN
        RAISE EXCEPTION 'an unscored criterion could not be removed';
    END IF;

    RAISE NOTICE 'OK 7: an unscored criterion can be deleted';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Names that differ only by case or spacing are the same name.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.rating_criteria (organization_id, name)
        VALUES ('c0570000-0000-4000-8000-000000000000', '  إتقان تحضير المشاوي  ');
        RAISE EXCEPTION 'a duplicate criterion name was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 8: duplicate names are refused after trimming';
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. The overall rating stays the manager's, whatever the criteria say.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_average numeric;
    v_overall smallint;
BEGIN
    -- Every ACTIVE criterion scored 5.
    INSERT INTO public.employee_criterion_scores
        (organization_id, employee_id, rated_by, criterion_id, period_month, score)
    SELECT 'c0570000-0000-4000-8000-000000000000',
           'c0570003-0000-4000-8000-000000000003',
           'c0570002-0000-4000-8000-000000000002',
           c.id, date_trunc('month', now())::date, 5
      FROM public.rating_criteria c
     WHERE c.organization_id = 'c0570000-0000-4000-8000-000000000000' AND c.is_active
    ON CONFLICT (organization_id, employee_id, period_month, criterion_id)
    DO UPDATE SET score = 5;

    SELECT round(SUM(s.score * c.weight) / SUM(c.weight), 2) INTO v_average
      FROM public.employee_criterion_scores s
      JOIN public.rating_criteria c ON c.id = s.criterion_id
     WHERE s.organization_id = 'c0570000-0000-4000-8000-000000000000'
       AND s.employee_id = 'c0570003-0000-4000-8000-000000000003'
       AND s.period_month = date_trunc('month', now())::date;

    IF v_average IS DISTINCT FROM 5.00 THEN
        RAISE EXCEPTION 'all fives should weight-average to 5, got %', v_average;
    END IF;

    -- ...and the manager still says 3, because they still think 3.
    INSERT INTO public.employee_ratings
        (organization_id, employee_id, rated_by, period_month, score, note)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            'c0570003-0000-4000-8000-000000000003',
            'c0570002-0000-4000-8000-000000000002',
            date_trunc('month', now())::date, 3, 'كل بند ممتاز، لكن الحضور الكلي يحتاج متابعة')
    ON CONFLICT (organization_id, employee_id, period_month)
    DO UPDATE SET score = 3;

    SELECT score INTO v_overall FROM public.employee_ratings
     WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
       AND employee_id = 'c0570003-0000-4000-8000-000000000003'
       AND period_month = date_trunc('month', now())::date;

    IF v_overall <> 3 THEN
        RAISE EXCEPTION 'the criterion scores overwrote the overall rating (got %)', v_overall;
    END IF;

    RAISE NOTICE 'OK 9: weighted average 5, overall 3 — the disagreement survives';
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. Cross-tenant: another restaurant's rubric is invisible.
--
--     Aimed at the LITERAL id seeded by cross_tenant_fixture, not at a lookup
--     by slug. The lookup cannot work from here — RLS hides that organization's
--     row from our manager too, so the query returns NULL and the assertion
--     turns into "nothing is not visible", which is true of everything.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_foreign uuid := '0c17e400-000f-400f-800f-00000000000f';
    v_seen    int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.rating_criteria WHERE id = v_foreign;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'our manager can see another restaurant''s criterion';
    END IF;

    RAISE NOTICE 'OK 10: another restaurant''s rubric is invisible';
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. THE ONE RLS CANNOT DO: a score may not point at a foreign criterion.
--
--     RLS would merely HIDE that criterion from a SELECT. The score row itself
--     carries our own organization_id, so every policy on it is satisfied — a
--     policy has nothing to object to. Only the composite foreign key notices
--     that (criterion_id, organization_id) names no row, and foreign key checks
--     run outside RLS, which is exactly why the constraint and not the policy is
--     the boundary here.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    -- A LITERAL id, seeded by cross_tenant_fixture.sql as postgres. It cannot
    -- be looked up here: this runs as mosaiz_app_user, RLS hides the row, and a
    -- SELECT would return NULL — turning the attempt below into an insert of
    -- NULL that fails for the wrong reason and proves nothing.
    v_foreign uuid := '0c17e400-000f-400f-800f-00000000000f';
BEGIN
    BEGIN
        INSERT INTO public.employee_criterion_scores
            (organization_id, employee_id, rated_by, criterion_id, period_month, score)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570003-0000-4000-8000-000000000003',
                'c0570002-0000-4000-8000-000000000002',
                v_foreign, date_trunc('month', now())::date, 5);
        RAISE EXCEPTION 'a score was written against another restaurant''s criterion';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 11: the composite key refuses a cross-tenant criterion';
END;
$$;

\echo 'rating_criteria_verification: all checks passed'
