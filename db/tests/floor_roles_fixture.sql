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
    ('f10c0006-0000-4000-8000-000000000006', 'solo-owner@ci.test'),
    -- A cashier, who exists here to be LEFT OUT of things. Without somebody in
    -- the fixture who should not be notified, every "we did not disturb them"
    -- assertion skips itself — which is exactly how 0041's containment check
    -- passed while the cashier was being dragged into the online queue.
    ('f10c0007-0000-4000-8000-000000000007', 'floor-cashier@ci.test'),
    -- An accountant: the interesting middle case for 0042. They may READ
    -- everybody's pay, because running payroll is their job, and may set
    -- nobody's, because deciding pay is not.
    ('f10c0008-0000-4000-8000-000000000008', 'floor-accountant@ci.test');

-- The two new roles, plus a manager so the suite has somebody who CAN do the
-- things the other two must not.
INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0001-0000-4000-8000-000000000001', 'waiter'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0002-0000-4000-8000-000000000002', 'kitchen'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0003-0000-4000-8000-000000000003', 'branch_manager'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0004-0000-4000-8000-000000000004', 'owner'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0005-0000-4000-8000-000000000005', 'regional_manager'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0007-0000-4000-8000-000000000007', 'cashier'),
    ('f10c0000-0000-4000-8000-000000000000', 'f10c0008-0000-4000-8000-000000000008', 'accountant');

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

-- A DISH and a QUEUED ORDER belonging to the other restaurant (0040), with
-- literal ids.
--
-- Both exist for the same reason as everything else in this block: a
-- cross-tenant assertion needs a foreign row that actually exists, or it
-- "passes" by finding nothing. Two counterfactuals proved that the hard way —
-- dropping the tenant filter from the public order path, and opening the queue
-- to every tenant, were both undetected until these rows existed.
INSERT INTO public.sellable_items (id, organization_id, name, price, is_active)
VALUES ('5e11ab1e-000f-400f-800f-00000000000f',
        'f10c1000-0000-4000-8000-000000000000', 'طبق المنشأة الأخرى', 99.00, true)
ON CONFLICT DO NOTHING;

INSERT INTO public.storefronts (organization_id, slug, display_name, is_accepting)
VALUES ('f10c1000-0000-4000-8000-000000000000', 'other-restaurant',
        'المنشأة الأخرى', true)
ON CONFLICT DO NOTHING;

INSERT INTO public.public_orders
    (id, organization_id, tracking_token, customer_name, customer_phone, quoted_total)
VALUES ('0d0e4000-000f-400f-800f-00000000000f',
        'f10c1000-0000-4000-8000-000000000000',
        'f0f0f0f0-000f-400f-800f-00000000000f',
        'زبون المنشأة الأخرى', '01099999999', 99.00)
ON CONFLICT DO NOTHING;

-- A table belonging to the OTHER restaurant (0039), with a literal id.
--
-- Seeded here as postgres for the same reason as the foreign menu change
-- request above: the app role cannot create a row in an organization it does
-- not belong to, and RLS hides other tenants' rows from it entirely — so a
-- suite that tried to seed this as itself would be asserting against nothing.
--
-- It exists so the reservation suite can attempt the one case that isolates
-- the COMPOSITE foreign key: our own organization_id paired with a table that
-- is not ours. RLS permits that row (the org is ours); only the composite key
-- refuses it.
INSERT INTO public.restaurant_tables (id, organization_id, label, seats)
VALUES ('7ab1e000-000f-400f-800f-00000000000f',
        'f10c1000-0000-4000-8000-000000000000', 'طاولة المنشأة الأخرى', 4)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
    missing text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT FROM public.organization_memberships
                    WHERE user_id = 'f10c0001-0000-4000-8000-000000000001' AND role = 'waiter') THEN
        missing := missing || 'waiter membership'; END IF;

    IF NOT EXISTS (SELECT FROM public.restaurant_tables
                    WHERE id = '7ab1e000-000f-400f-800f-00000000000f') THEN
        missing := missing || 'foreign table'; END IF;

    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE id = '5e11ab1e-000f-400f-800f-00000000000f') THEN
        missing := missing || 'foreign dish'; END IF;

    IF NOT EXISTS (SELECT FROM public.public_orders
                    WHERE id = '0d0e4000-000f-400f-800f-00000000000f') THEN
        missing := missing || 'foreign public order'; END IF;
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
