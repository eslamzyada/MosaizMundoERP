-- ============================================================================
-- internal_link_verification.sql — a notification cannot carry somebody
-- off-site (0051)
--
-- 0036 stated this invariant in a comment and enforced `LIKE '/%'`, which
-- accepts `//evil.com`, `/\evil.com` and `/<TAB>/evil.com` — three spellings
-- of the same thing, all of which a browser resolves to another origin.
--
-- Both halves are asserted here, and the second is the one that rots:
--
--   1. the shapes that can leave the application are REFUSED;
--   2. the links the application actually writes are still ACCEPTED.
--
-- Without (2), a constraint that refuses everything passes this whole file
-- while silently breaking the notification bell — and a click that does
-- nothing is a bug nobody reports.
--
-- Runs as postgres. This is about a CHECK constraint, not about RLS: the
-- constraint applies to every writer, which is the reason for moving the rule
-- here from the client in the first place.
--
-- ----------------------------------------------------------------------------
-- WHY THERE IS NO ENTRY IN negative_checks.sh, which is where a "must be
-- rejected" case normally lives.
--
-- That file runs as mosaiz_app_user, and measured on the live database:
--
--     has_table_privilege('mosaiz_app_user', 'public.notifications', 'INSERT')  -> false
--     has_function_privilege('mosaiz_app_user', 'app.notify_user(...)', ...)    -> false
--
-- So every hostile link tried from there is refused by PRIVILEGE, never by the
-- constraint — SQLSTATE 42501, not 23514. The check would pass, print
-- "rejected as expected", and prove nothing whatsoever about the predicate
-- this migration exists to fix. A first draft of this suite did exactly that.
--
-- Hence: postgres, and `EXCEPTION WHEN check_violation` rather than a bare
-- catch, so a refusal for any other reason fails the suite instead of
-- flattering it.
-- ============================================================================

DO $$
DECLARE
    v_org  uuid;
    v_user uuid;
    v_link text;
    v_kind constant text := 'link_check_probe';
BEGIN
    -- Any real (organization, member) pair. This is a CHECK constraint, which
    -- applies to every row regardless of tenant, so naming a particular
    -- fixture would only couple this suite to somebody else's seed data.
    --
    -- It did, in the first draft: ci-bistro-cairo was the obvious choice and
    -- it has NO members by the time this runs — admin_checks.sql deletes the
    -- identities on purpose, to prove an organization survives losing them.
    SELECT m.organization_id, m.user_id
      INTO v_org, v_user
      FROM public.organization_memberships m
     LIMIT 1;

    -- Counterfactual guard: a lookup that finds nothing would make every
    -- assertion below vacuous — the loops would run zero times and the file
    -- would pass having proved nothing at all.
    IF v_org IS NULL OR v_user IS NULL THEN
        RAISE EXCEPTION
            'link check: no organization with a member exists, so every assertion below would be vacuous';
    END IF;

    -- ------------------------------------------------------------------
    -- 1. Everything that could leave the application.
    -- ------------------------------------------------------------------
    FOREACH v_link IN ARRAY ARRAY[
        -- Protocol-relative: the browser supplies the scheme and departs.
        '//evil.com',
        '///evil.com',
        -- A backslash is normalised to a forward slash, giving //evil.com.
        -- This is the exact shape the admin app's old guard let through:
        -- it tested startsWith('//') and this does not start with '//'.
        '/\evil.com',
        '/\\evil.com',
        -- Whitespace and control characters are STRIPPED before a URL is
        -- resolved, so each of these is //evil.com by the time it matters
        -- while looking harmless to a naive prefix test.
        E'/\t/evil.com',
        E'/\n//evil.com',
        E'/\r/evil.com',
        '/ /evil.com',
        -- Not relative at all.
        'https://evil.com',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        -- Does not start at the root.
        'menu',
        -- Over the length ceiling.
        '/' || repeat('a', 300)
    ] LOOP
        BEGIN
            INSERT INTO public.notifications
                (organization_id, recipient_id, kind, subject, link)
            VALUES (v_org, v_user, v_kind, 'probe', v_link);

            RAISE EXCEPTION
                'link check: ACCEPTED %, which can carry somebody off-site',
                replace(replace(v_link, E'\n', '<LF>'), E'\t', '<TAB>');
        EXCEPTION
            WHEN check_violation THEN
                NULL;  -- refused, as required
        END;
    END LOOP;

    -- ------------------------------------------------------------------
    -- 2. Everything the application actually writes.
    --
    -- These are the literals in the SECURITY DEFINER triggers that raise
    -- notifications today. If a tightened rule refuses one of them, the bell
    -- stops working and nothing else in this suite would notice.
    -- ------------------------------------------------------------------
    FOREACH v_link IN ARRAY ARRAY[
        '/menu',
        '/reservations',
        '/modules',
        '/reports',
        '/online-orders',
        -- Shapes a future notification would reasonably use.
        '/reports?from=2026-01-01&to=2026-01-31',
        '/orders/8f14e45f-ceea-467a-9f2a-1a2b3c4d5e6f',
        '/',
        '/menu#section'
    ] LOOP
        BEGIN
            INSERT INTO public.notifications
                (organization_id, recipient_id, kind, subject, link)
            VALUES (v_org, v_user, v_kind, 'probe', v_link);
        EXCEPTION
            WHEN check_violation THEN
                RAISE EXCEPTION
                    'link check: REFUSED %, which the application writes today',
                    v_link;
        END;
    END LOOP;

    -- NULL stays legal: most notifications have nowhere in particular to go.
    INSERT INTO public.notifications
        (organization_id, recipient_id, kind, subject, link)
    VALUES (v_org, v_user, v_kind, 'probe', NULL);

    -- Scoped by the probe kind, never a blanket DELETE.
    DELETE FROM public.notifications WHERE kind = v_kind;

    RAISE NOTICE 'link check: off-site links refused, real links accepted';
END;
$$;

-- ----------------------------------------------------------------------------
-- And that the constraint is TRUSTED, not merely present.
--
-- `ADD CONSTRAINT ... NOT VALID` records a constraint that applies to new rows
-- while leaving existing ones unchecked. 0051 validates it in the same
-- transaction; this asserts that the VALIDATE actually happened, because a
-- convalidated=false constraint reads exactly like a real one in \d output.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_validated boolean;
BEGIN
    SELECT convalidated INTO v_validated
      FROM pg_constraint
     WHERE conrelid = 'public.notifications'::regclass
       AND conname = 'notifications_link_check';

    IF v_validated IS NULL THEN
        RAISE EXCEPTION 'link check: notifications_link_check is missing entirely';
    END IF;
    IF NOT v_validated THEN
        RAISE EXCEPTION
            'link check: notifications_link_check exists but was never validated, so rows written before 0051 were never checked';
    END IF;
END;
$$;
