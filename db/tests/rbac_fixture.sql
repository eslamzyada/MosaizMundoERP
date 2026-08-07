-- ============================================================================
-- RBAC fixture — runs as postgres (owner, bypasses ENABLE-only RLS).
--
-- Creates one org with a member per role, plus enough catalog/stock for a sale.
-- Must run as the superuser: organization_memberships is deny-by-default for
-- the app role (no INSERT policy), so the app role cannot seed a cashier.
--
-- Run order: AFTER admin_checks.sql. That suite asserts memberships have been
-- fully scrubbed (count = 0), so seeding these rows any earlier breaks it.
-- Paired with: rbac_verification.sql (runs next, as mosaiz_app_user).
-- ============================================================================
\set ON_ERROR_STOP on

INSERT INTO public.users (id, email) VALUES
    ('a11c0001-0000-4000-8000-000000000001', 'rbac-owner@ci.test'),
    ('a11c0002-0000-4000-8000-000000000002', 'rbac-branch-manager@ci.test'),
    ('a11c0003-0000-4000-8000-000000000003', 'rbac-cashier@ci.test'),
    ('a11c0004-0000-4000-8000-000000000004', 'rbac-accountant@ci.test');

INSERT INTO public.organizations (id, name, slug, plan_tier) VALUES
    -- Enterprise (0044): the role assertions below reach recipes,
    -- purchasing and performance, none of which basic includes.
    ('a11c0000-0000-4000-8000-000000000000', 'RBAC Test Org', 'ci-rbac-org', 'enterprise');

INSERT INTO public.organization_memberships (organization_id, user_id, role) VALUES
    ('a11c0000-0000-4000-8000-000000000000', 'a11c0001-0000-4000-8000-000000000001', 'owner'),
    ('a11c0000-0000-4000-8000-000000000000', 'a11c0002-0000-4000-8000-000000000002', 'branch_manager'),
    ('a11c0000-0000-4000-8000-000000000000', 'a11c0003-0000-4000-8000-000000000003', 'cashier'),
    ('a11c0000-0000-4000-8000-000000000000', 'a11c0004-0000-4000-8000-000000000004', 'accountant');

-- Catalog + a recipe + stock, so a cashier's sale has something to draw down.
INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure, reorder_threshold)
VALUES ('a11cf00d-0000-4000-8000-000000000001',
        'a11c0000-0000-4000-8000-000000000000', 'RBAC Chicken', 'grams', 100);

INSERT INTO public.sellable_items (id, organization_id, name, price)
VALUES ('a11c5e11-0000-4000-8000-000000000001',
        'a11c0000-0000-4000-8000-000000000000', 'RBAC Shawarma', 50.00);

INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required)
VALUES ('a11c0000-0000-4000-8000-000000000000',
        'a11c5e11-0000-4000-8000-000000000001',
        'a11cf00d-0000-4000-8000-000000000001', 10);

INSERT INTO public.inventory_batches
    (id, organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
VALUES ('a11cba7c-0000-4000-8000-000000000001',
        'a11c0000-0000-4000-8000-000000000000',
        'a11cf00d-0000-4000-8000-000000000001', 1000, 1000, 0.10);

SELECT 'rbac_fixture: seeded org with owner/branch_manager/cashier/accountant' AS result;
