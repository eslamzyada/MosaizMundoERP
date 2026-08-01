-- ============================================================================
-- Fixture: a restaurant with a waiter, a kitchen and a manager (0034)
-- Runs as postgres — the app role has no INSERT policy on users/organizations.
--
-- Paired with floor_roles_verification.sql, which runs next as mosaiz_app_user.
--
-- Literal uuids throughout, so the verification can address these identities
-- without a lookup. A lookup that finds nobody makes every assertion after it
-- vacuously true, which is the failure this whole suite exists to avoid.
-- ============================================================================
\set ON_ERROR_STOP on

INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES
    ('f10c0000-0000-4000-8000-000000000000', 'CI Floor Bistro', 'ci-floor-bistro', 'basic');

INSERT INTO public.users (id, email) VALUES
    ('f10c0001-0000-4000-8000-000000000001', 'floor-waiter@ci.test'),
    ('f10c0002-0000-4000-8000-000000000002', 'floor-kitchen@ci.test'),
    ('f10c0003-0000-4000-8000-000000000003', 'floor-manager@ci.test'),
    -- The two who can DECIDE a menu change (0035). Two of them, so the
    -- two-person rule is in force here and can actually be tested.
    ('f10c0004-0000-4000-8000-000000000004', 'floor-owner@ci.test'),
    ('f10c0005-0000-4000-8000-000000000005', 'floor-regional@ci.test'),
    -- A lone owner in a SECOND organization, for the one case where the
    -- two-person rule has to yield: a restaurant with nobody else to ask.
    ('f10c0006-0000-4000-8000-000000000006', 'solo-owner@ci.test');

-- The two new roles, plus a manager so the suite has somebody who CAN do the
-- things the other two must not.
INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0001-0000-4000-8000-000000000001', 'waiter'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0002-0000-4000-8000-000000000002', 'kitchen'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0003-0000-4000-8000-000000000003', 'branch_manager'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0004-0000-4000-8000-000000000004', 'owner'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0005-0000-4000-8000-000000000005', 'regional_manager');

-- The one-approver restaurant.
INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES
    ('f10c1000-0000-4000-8000-000000000000', 'CI Solo Bistro', 'ci-solo-bistro', 'basic');

INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES
    ('f10c1000-0000-4000-8000-000000000000', 'f10c0006-0000-4000-8000-000000000006', 'owner');

-- Something on the menu, so "the kitchen can read the menu" is a claim about
-- visibility rather than about an empty table.
INSERT INTO public.sellable_items (id, organization_id, name, price) VALUES
    ('f10c5e11-0000-4000-8000-000000000001',
     'f10c0000-0000-4000-8000-000000000000', 'فتّة لحم', 85.00);

-- An invitation for each new role. This is the SECOND place the vocabulary is
-- written down, and a role that can be granted but not invited fails at the far
-- end of a sign-up flow — the worst place to discover it.
INSERT INTO public.organization_invitations
    (organization_id, email, role, invited_by)
VALUES
    ('f10c0000-0000-4000-8000-000000000000', 'new-waiter@ci.test', 'waiter',
     'f10c0003-0000-4000-8000-000000000003'),
    ('f10c0000-0000-4000-8000-000000000000', 'new-kitchen@ci.test', 'kitchen',
     'f10c0003-0000-4000-8000-000000000003');

-- Another restaurant's pending menu change, with a LITERAL id. The suite runs
-- as mosaiz_app_user and RLS hides this row, so it cannot be looked up — and an
-- assertion aimed at NULL passes for the wrong reason.
INSERT INTO public.menu_change_requests
    (id, organization_id, kind, proposed_name, proposed_price, reason, requested_by)
VALUES ('0e17e400-000f-400f-800f-00000000000f',
        'f10c1000-0000-4000-8000-000000000000', 'create',
        'طبق المنشأة الأخرى', 55.00, 'اقتراح من منشأة أخرى تمامًا',
        'f10c0006-0000-4000-8000-000000000006')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    missing text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT FROM public.organization_memberships
                    WHERE user_id = 'f10c0001-0000-4000-8000-000000000001' AND role = 'waiter') THEN
        missing := missing || 'waiter membership'; END IF;
    IF NOT EXISTS (SELECT FROM public.organization_memberships
                    WHERE user_id = 'f10c0002-0000-4000-8000-000000000002' AND role = 'kitchen') THEN
        missing := missing || 'kitchen membership'; END IF;
    IF NOT EXISTS (SELECT FROM public.organization_invitations
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                      AND role = 'waiter') THEN
        missing := missing || 'waiter invitation'; END IF;
    IF NOT EXISTS (SELECT FROM public.organization_invitations
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                      AND role = 'kitchen') THEN
        missing := missing || 'kitchen invitation'; END IF;

    IF NOT EXISTS (SELECT FROM public.menu_change_requests
                    WHERE id = '0e17e400-000f-400f-800f-00000000000f') THEN
        missing := missing || 'foreign menu change request'; END IF;

    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'floor roles fixture seeded nothing for %', array_to_string(missing, ', ');
    END IF;
END;
$$;

SELECT 'floor_roles_fixture: seeded a waiter, a kitchen, a manager, two deciders, a solo owner and two invitations' AS result;
