-- ============================================================================
-- Admin checks — runs as postgres (owner, bypasses ENABLE-only RLS).
-- Verifies transactional atomicity of the provisioning pipeline and the
-- ON DELETE CASCADE from users to organization_memberships.
-- Run order: after negative_checks.sh.
-- ============================================================================
\set ON_ERROR_STOP on

-- Atomicity: the failed provisioning calls in negative_checks (invalid tier,
-- duplicate slug) must have rolled back their step-1 users INSERT too.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.users
        WHERE id IN ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                     'ffffffff-ffff-4fff-8fff-ffffffffffff')
    ) THEN
        RAISE EXCEPTION 'atomicity breach: failed provisioning leaked a users row';
    END IF;
END;
$$;

-- FK cascade: wiping the identity scrubs its memberships automatically;
-- the organizations themselves remain (ownerless, but intact).
DELETE FROM public.users WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

DO $$
BEGIN
    IF (SELECT count(*) FROM public.organization_memberships) <> 0 THEN
        RAISE EXCEPTION 'ON DELETE CASCADE failed to scrub memberships';
    END IF;
    IF (SELECT count(*) FROM public.organizations) <> 2 THEN
        RAISE EXCEPTION 'organizations must survive identity deletion (expected 2 orphaned orgs)';
    END IF;
END;
$$;

SELECT 'admin_checks: all assertions passed' AS result;
