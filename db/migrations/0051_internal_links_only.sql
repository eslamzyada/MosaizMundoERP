-- ============================================================================
-- 0051_internal_links_only.sql — make the link constraint mean what 0036 said
--
-- 0036 wrote the intent down exactly:
--
--     -- Where to go. A relative path inside the admin, never a full URL: a
--     -- notification that can carry an arbitrary link is a notification that
--     -- can carry somebody off-site.
--     link text CHECK (link IS NULL OR (link LIKE '/%' AND char_length(link) <= 300))
--
-- The comment is right and the predicate does not enforce it. `LIKE '/%'`
-- accepts every one of these:
--
--     //evil.com        a protocol-relative URL. The browser fills in the
--                       scheme and leaves.
--     /\evil.com        a backslash, which the browser NORMALISES to `/`,
--                       giving //evil.com.
--     /<TAB>/evil.com   whitespace and control characters are STRIPPED before
--                       a URL is resolved, giving //evil.com again.
--
-- All three start with a slash, so all three are stored today.
--
-- ----------------------------------------------------------------------------
-- IS IT REACHABLE? Not right now, and that is not the point.
--
-- Every link written today is a literal in a SECURITY DEFINER trigger —
-- '/menu', '/reservations', '/modules', '/reports', '/online-orders'. User
-- input reaches a notification's subject and body, never its link, and the API
-- exposes no endpoint that creates a notification at all.
--
-- So this constraint has never had to hold. That is exactly when a constraint
-- is worth fixing: while it is free. The invariant "a notification cannot carry
-- somebody off-site" is one somebody will rely on when they add the first
-- notification whose link is built from a name, an id, or a search term — and
-- they will rely on it because 0036 says so in a comment.
--
-- The admin app's own guard had the same hole and has been replaced
-- (clients/admin/src/lib/safeInternalPath.ts). This is the same rule at the
-- layer that owns the data, so it holds for anything that ever writes here —
-- a future service, a backfill, a psql session at 2am.
--
-- ----------------------------------------------------------------------------
-- THE PREDICATE is an ALLOWLIST, not a list of the three tricks above.
--
-- Writing it as denials would mean writing down the spellings somebody has
-- already thought of, which is how the original guard came to accept a
-- backslash: it was written against `//`, and `/\` is the same attack spelled
-- differently. An allowlist of the characters a path may contain refuses every
-- spelling, including the ones nobody has published yet.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Any row that the new rule refuses loses its LINK, not its notification.
--
-- The message still says what happened and who did it; only the destination
-- goes. Deleting the row would hide evidence of the very thing worth finding,
-- and leaving it would keep a live off-site link one click away.
--
-- Expected to touch nothing — every link written so far is a literal — so the
-- NOTICE is what says whether that expectation held on this database.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_cleared integer;
BEGIN
    UPDATE public.notifications
       SET link = NULL
     WHERE link IS NOT NULL
       AND NOT (link ~ '^/[A-Za-z0-9/?&=#%+._~-]*$' AND link !~ '^//');

    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    IF v_cleared > 0 THEN
        RAISE WARNING
            '0051 cleared % notification link(s) that could leave the application', v_cleared;
    ELSE
        RAISE NOTICE '0051: no stored link needed clearing';
    END IF;
END;
$$;

ALTER TABLE public.notifications
    DROP CONSTRAINT notifications_link_check;

-- NOT VALID, then VALIDATE, deliberately.
--
-- Adding a validated CHECK holds ACCESS EXCLUSIVE for the whole table scan; on
-- a notifications table with a year of alerts in it that is a write stall on
-- every till in the estate. NOT VALID takes that lock only long enough to
-- record the constraint, and VALIDATE then scans under SHARE UPDATE EXCLUSIVE,
-- which readers and writers do not queue behind.
--
-- It is validated in the same transaction, so the constraint is fully trusted
-- when this migration ends. NOT VALID is about the lock, never about accepting
-- a row that breaks the rule.
ALTER TABLE public.notifications
    ADD CONSTRAINT notifications_link_check CHECK (
        link IS NULL
        OR (
            -- Starts at the application root, and is built only from the
            -- characters a path, a query and a fragment are made of. A
            -- backslash, a space, a tab, a newline, a quote or a control
            -- character is absent from this set, so every one of them is
            -- refused without having to be named.
            link ~ '^/[A-Za-z0-9/?&=#%+._~-]*$'
            -- ...and not a protocol-relative URL. `//evil.com` is built
            -- entirely from allowed characters, so this is the one shape the
            -- allowlist cannot refuse by itself.
            AND link !~ '^//'
            AND char_length(link) <= 300
        )
    ) NOT VALID;

ALTER TABLE public.notifications
    VALIDATE CONSTRAINT notifications_link_check;

COMMENT ON COLUMN public.notifications.link IS
    'Where to go, as a path inside the admin. Enforced by an allowlist (0051): anything a browser could resolve to another origin — //host, a backslash, whitespace, a control character — is refused here rather than at the client, so the rule holds for every writer.';

-- ----------------------------------------------------------------------------
-- The proof. A constraint whose predicate is wrong looks exactly like one
-- whose predicate is right, so assert the shapes rather than the existence.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_link text;
    v_org uuid;
    v_user uuid;
BEGIN
    -- A tenant and a recipient to hang a row on. Any will do; this is about
    -- the CHECK, not about tenancy.
    SELECT id INTO v_org FROM public.organizations LIMIT 1;
    SELECT user_id INTO v_user FROM public.organization_memberships
     WHERE organization_id = v_org LIMIT 1;

    IF v_org IS NULL OR v_user IS NULL THEN
        RAISE NOTICE '0051: no tenant on this database yet; the CHECK is asserted by db/tests';
        RETURN;
    END IF;

    FOREACH v_link IN ARRAY ARRAY[
        '//evil.com',            -- protocol-relative
        '/\evil.com',            -- backslash, normalised to // by a browser
        E'/\t/evil.com',         -- control character, stripped before resolving
        E'/\n//evil.com',        -- newline, likewise
        '/ /evil.com',           -- space, likewise
        'https://evil.com',      -- not even relative
        'javascript:alert(1)'    -- not a path at all
    ] LOOP
        BEGIN
            INSERT INTO public.notifications
                (organization_id, recipient_id, kind, subject, link)
            VALUES (v_org, v_user, 'migration_probe_0051', 'probe', v_link);

            RAISE EXCEPTION
                '0051: the link constraint ACCEPTED %, which can leave the application',
                v_link;
        EXCEPTION
            WHEN check_violation THEN
                NULL;  -- refused, which is the point
        END;
    END LOOP;

    -- And the other half: a rule that refuses everything would pass every test
    -- above while silently breaking the bell. These are the links the triggers
    -- actually write.
    FOREACH v_link IN ARRAY ARRAY[
        '/menu', '/reservations', '/modules', '/reports', '/online-orders',
        '/reports?from=2026-01-01&to=2026-01-31'
    ] LOOP
        BEGIN
            INSERT INTO public.notifications
                (organization_id, recipient_id, kind, subject, link)
            VALUES (v_org, v_user, 'migration_probe_0051', 'probe', v_link);
        EXCEPTION
            WHEN check_violation THEN
                RAISE EXCEPTION
                    '0051: the link constraint REFUSED %, which the application writes today',
                    v_link;
        END;
    END LOOP;

    -- Scoped by the probe kind, never a blanket DELETE.
    DELETE FROM public.notifications WHERE kind = 'migration_probe_0051';
END;
$$;

COMMIT;
