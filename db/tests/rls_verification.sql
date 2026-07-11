-- ============================================================================
-- RLS verification — runs as mosaiz_app_user (non-owner, RLS applies).
-- Every expectation is asserted in a DO block: any mismatch raises an
-- exception, psql exits non-zero, and CI fails. Assumes a freshly migrated,
-- empty database.
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. Tenant bootstrap through the SECURITY DEFINER pipeline. Direct INSERTs
--    into users/organizations are denied to this role (see negative_checks),
--    so success here proves the procedure is the working RLS-crossing path.
CALL app.provision_new_tenant(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'owner.c@ci.test',
    'CI Bistro Cairo',
    'ci-bistro-cairo',
    'premium'
);

SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

DO $$
BEGIN
    IF (SELECT count(*) FROM public.users) <> 1 THEN
        RAISE EXCEPTION 'users_select_own: owner should see exactly their own row';
    END IF;
    IF (SELECT count(*) FROM public.organizations) <> 1
       OR (SELECT min(slug) FROM public.organizations) <> 'ci-bistro-cairo' THEN
        RAISE EXCEPTION 'user_belongs_to_org: owner should see exactly the provisioned org';
    END IF;
    IF (SELECT count(*) FROM public.organization_memberships WHERE role = 'owner') <> 1 THEN
        RAISE EXCEPTION 'provisioning should create exactly one owner membership';
    END IF;
END;
$$;

-- 2. users_update_own policy + updated_at trigger.
UPDATE public.users
SET email = 'owner.c.updated@ci.test'
WHERE id = app.current_user_id();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.users
        WHERE email = 'owner.c.updated@ci.test'
          AND updated_at > created_at
    ) THEN
        RAISE EXCEPTION 'own-row UPDATE or app.set_updated_at trigger failed';
    END IF;
END;
$$;

-- 3. Multi-branch franchising: the SAME identity provisions a second org
--    (exercises ON CONFLICT (id) DO NOTHING on the users insert).
CALL app.provision_new_tenant(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'owner.c.updated@ci.test',
    'CI Bistro Giza',
    'ci-bistro-giza',
    'basic'
);

DO $$
BEGIN
    IF (SELECT count(*) FROM public.organizations) <> 2
       OR (SELECT count(*) FROM public.organization_memberships) <> 2 THEN
        RAISE EXCEPTION 'multi-branch: existing identity must be able to own a second org';
    END IF;
END;
$$;

-- 4. Isolation: an unrelated session user sees nothing.
SET app.current_user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

DO $$
BEGIN
    IF (SELECT count(*) FROM public.users) <> 0
       OR (SELECT count(*) FROM public.organizations) <> 0
       OR (SELECT count(*) FROM public.organization_memberships) <> 0 THEN
        RAISE EXCEPTION 'isolation breach: stranger can see another tenant''s rows';
    END IF;
END;
$$;

-- 5. DELETE on users has no policy -> default deny -> zero rows affected.
SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

DO $$
DECLARE
    n integer;
BEGIN
    DELETE FROM public.users WHERE id = app.current_user_id();
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
        RAISE EXCEPTION 'DELETE on users must be denied by default (removed % rows)', n;
    END IF;
END;
$$;

SELECT 'rls_verification: all assertions passed' AS result;
