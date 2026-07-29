-- ============================================================================
-- Preferences and branding verification (0032).
--
-- The assertion that matters is the one that is easy to get wrong and invisible
-- when it is: A PREFERENCE IS PRIVATE. The org policy alone would let every
-- member of a restaurant read and rewrite every colleague's settings, and
-- nothing on screen would ever reveal it — you would simply find your text size
-- changed and have no idea why.
--
-- The branding half is the opposite shape: everyone reads it (a till prints the
-- logo), only administrators change it.
--
-- Run order: after printer_verification.sql (uses the COGS fixture identities:
-- cashier c0570001, branch_manager c0570002, accountant c0570003).
-- ============================================================================
\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. A cashier sets their own preferences.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_theme text;
    v_scale smallint;
BEGIN
    INSERT INTO public.user_preferences (organization_id, user_id, theme, text_scale)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            'c0570001-0000-4000-8000-000000000001', 'dark', 130);

    SELECT theme, text_scale INTO v_theme, v_scale
    FROM public.user_preferences
    WHERE user_id = 'c0570001-0000-4000-8000-000000000001';

    IF v_theme <> 'dark' OR v_scale <> 130 THEN
        RAISE EXCEPTION 'the cashier''s own preferences did not save (% / %)', v_theme, v_scale;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Defaults are sensible without being stated.
--
--    'system' rather than a guess: the right theme for most people is the one
--    they already chose in their operating system.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_theme text;
    v_scale smallint;
BEGIN
    INSERT INTO public.user_preferences (organization_id, user_id)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            'c0570002-0000-4000-8000-000000000002');

    SELECT theme, text_scale INTO v_theme, v_scale
    FROM public.user_preferences
    WHERE user_id = 'c0570002-0000-4000-8000-000000000002';

    IF v_theme <> 'system' THEN
        RAISE EXCEPTION 'theme must default to system, got %', v_theme;
    END IF;
    IF v_scale <> 100 THEN
        RAISE EXCEPTION 'text scale must default to 100, got %', v_scale;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. THE ASSERTION THIS TABLE EXISTS FOR: a colleague's preferences are
--    invisible and untouchable, even inside the same restaurant.
--
--    The manager is currently signed in. The cashier's row is in the same
--    organization, so the org policy alone would expose it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_seen  int;
    v_rows  int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.user_preferences
    WHERE user_id = 'c0570001-0000-4000-8000-000000000001';

    IF v_seen <> 0 THEN
        RAISE EXCEPTION
            'A COLLEAGUE''S PREFERENCES ARE VISIBLE: the org policy alone lets '
            'every member read every other member''s settings, and nothing on '
            'screen would ever show it happening';
    END IF;

    -- Nor writable. RLS filters rather than raising, so a refused write
    -- silently updates NO ROW — which is why this counts rows rather than
    -- waiting for an exception that never comes.
    UPDATE public.user_preferences SET text_scale = 200
    WHERE user_id = 'c0570001-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'a manager rewrote a cashier''s text size';
    END IF;

    DELETE FROM public.user_preferences
    WHERE user_id = 'c0570001-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'a manager deleted a cashier''s preferences';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Nor can a row be created ON BEHALF of somebody else.
--
--    Separate from section 3 on purpose: reading and overwriting are governed
--    by USING, inserting by WITH CHECK, and a policy can easily have one
--    without the other.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    caught text;
BEGIN
    caught := NULL;
    BEGIN
        INSERT INTO public.user_preferences (organization_id, user_id, theme)
        VALUES ('c0570000-0000-4000-8000-000000000000',
                'c0570003-0000-4000-8000-000000000003', 'light');
    EXCEPTION WHEN insufficient_privilege THEN caught := SQLSTATE;
    END;

    IF caught IS NULL THEN
        RAISE EXCEPTION 'a manager created preferences in somebody else''s name';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Nonsense is refused by the database.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    caught text;
BEGIN
    caught := NULL;
    BEGIN
        UPDATE public.user_preferences SET theme = 'neon'
        WHERE user_id = 'c0570002-0000-4000-8000-000000000002';
    EXCEPTION WHEN check_violation THEN caught := SQLSTATE;
    END;
    IF caught IS NULL THEN
        RAISE EXCEPTION 'an unknown theme was accepted';
    END IF;

    -- Unreadably small and absurdly large are both refused: a stored value the
    -- interface would refuse to honour is worse than one never accepted.
    caught := NULL;
    BEGIN
        UPDATE public.user_preferences SET text_scale = 10
        WHERE user_id = 'c0570002-0000-4000-8000-000000000002';
    EXCEPTION WHEN check_violation THEN caught := SQLSTATE;
    END;
    IF caught IS NULL THEN
        RAISE EXCEPTION 'an unreadable text scale was accepted';
    END IF;

    caught := NULL;
    BEGIN
        UPDATE public.user_preferences SET text_scale = 500
        WHERE user_id = 'c0570002-0000-4000-8000-000000000002';
    EXCEPTION WHEN check_violation THEN caught := SQLSTATE;
    END;
    IF caught IS NULL THEN
        RAISE EXCEPTION 'an absurd text scale was accepted';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Branding: a manager sets it, and EVERY member can read it.
--
--    The read matters as much as the write — a till prints the logo, so a
--    cashier who cannot see it cannot print a receipt that carries it.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    INSERT INTO public.organization_branding (organization_id, logo_url, display_name)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            'https://example.supabase.co/storage/v1/object/public/branding/logo.png',
            'مطعم الاختبار');
END;
$$;

SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_name  text;
    v_rows  int;
    caught  text;
BEGIN
    SELECT display_name INTO v_name FROM public.organization_branding
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
    IF v_name IS DISTINCT FROM 'مطعم الاختبار' THEN
        RAISE EXCEPTION
            'a cashier cannot read the branding (got %), so a till could not '
            'print a receipt carrying it', COALESCE(v_name, 'nothing');
    END IF;

    -- But cannot change the restaurant's identity.
    UPDATE public.organization_branding SET display_name = 'مطعمي أنا'
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'a cashier renamed the restaurant';
    END IF;

    -- Nor delete it. The permissive FOR ALL policy covers DELETE, so this is
    -- only refused because require_admin_delete exists.
    DELETE FROM public.organization_branding
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION
            'a cashier DELETED the branding: the permissive FOR ALL policy '
            'covers DELETE, so the grant needs its own RESTRICTIVE gate';
    END IF;

    -- 42501 SPECIFICALLY. organization_branding is keyed on organization_id
    -- and a row already exists, so accepting any error here would pass on the
    -- PRIMARY KEY collision whether or not the policy still stood — which is
    -- exactly what an earlier version of this assertion did.
    caught := NULL;
    BEGIN
        INSERT INTO public.organization_branding (organization_id, display_name)
        VALUES ('c0570000-0000-4000-8000-000000000000', 'مطعم مهرب');
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION
            'a cashier inserted branding (got %); only a manager decides what '
            'the restaurant is called', COALESCE(caught, 'no error at all');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Another organization's branding and preferences are invisible.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.organization_branding
    WHERE organization_id <> 'c0570000-0000-4000-8000-000000000000';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'CROSS-TENANT LEAK: % foreign branding row(s) visible', v_seen;
    END IF;

    -- Preferences are checked too, but note what this does and does not
    -- prove: require_own_row (section 3) is STRICTLY STRONGER than the org
    -- policy, so while it stands this count is zero no matter what the org
    -- policy says. It is defence in depth, and it is only falsifiable with
    -- BOTH policies broken — which is what the counterfactual for it does.
    SELECT count(*) INTO v_seen FROM public.user_preferences
    WHERE organization_id <> 'c0570000-0000-4000-8000-000000000000';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'CROSS-TENANT LEAK: % foreign preference row(s) visible', v_seen;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. updated_at moves on its own, per the house convention.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before timestamptz;
    v_after  timestamptz;
BEGIN
    SELECT updated_at INTO v_before FROM public.user_preferences
    WHERE user_id = 'c0570001-0000-4000-8000-000000000001';

    PERFORM pg_sleep(0.01);
    UPDATE public.user_preferences SET theme = 'light'
    WHERE user_id = 'c0570001-0000-4000-8000-000000000001';

    SELECT updated_at INTO v_after FROM public.user_preferences
    WHERE user_id = 'c0570001-0000-4000-8000-000000000001';

    IF v_after <= v_before THEN
        RAISE EXCEPTION 'the updated_at trigger did not fire (% -> %)', v_before, v_after;
    END IF;
END;
$$;

SELECT 'preferences_verification: all assertions passed' AS result;
