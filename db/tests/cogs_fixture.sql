-- ============================================================================
-- COGS fixture (0015) — runs as postgres, like rbac_fixture.sql and for the
-- same reason: memberships are deny-by-default (0011), so the app role cannot
-- seed a cashier for itself.
--
-- Seeds one organization whose stock is deliberately split across two lots at
-- DIFFERENT prices, because that is the case where an average and the real FIFO
-- cost diverge — and only the real cost is right.
--
-- Run order: after admin_checks.sql (which asserts memberships count = 0).
-- ============================================================================
\set ON_ERROR_STOP on

INSERT INTO public.organizations (id, name, slug, plan_tier)
VALUES ('c0570000-0000-4000-8000-000000000000', 'CI COGS Bistro', 'ci-cogs-bistro', 'basic');

-- A CASHIER, not an owner: checkout is SECURITY INVOKER and in production runs
-- as this role, so the assertions must too.
INSERT INTO public.users (id, email)
VALUES ('c0570001-0000-4000-8000-000000000001', 'cogs-cashier@ci.test');

INSERT INTO public.organization_memberships (organization_id, user_id, role)
VALUES ('c0570000-0000-4000-8000-000000000000',
        'c0570001-0000-4000-8000-000000000001', 'cashier');

-- Ingredients ---------------------------------------------------------------
INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
VALUES ('c057f00d-0000-4000-8000-000000000001',
        'c0570000-0000-4000-8000-000000000000', 'COGS Patty', 'pieces'),
       ('c057f00d-0000-4000-8000-000000000002',
        'c0570000-0000-4000-8000-000000000000', 'COGS Cheese', 'grams');

-- Menu ----------------------------------------------------------------------
INSERT INTO public.sellable_items (id, organization_id, name, sku, price)
VALUES ('c0575e11-0000-4000-8000-000000000001',
        'c0570000-0000-4000-8000-000000000000', 'COGS Burger',      'COGS-BRG',   20),
       ('c0575e11-0000-4000-8000-000000000002',
        'c0570000-0000-4000-8000-000000000000', 'COGS Bare Item',   'COGS-BARE',  12),
       ('c0575e11-0000-4000-8000-000000000003',
        'c0570000-0000-4000-8000-000000000000', 'COGS Cheese Melt', 'COGS-MELT',  15),
       ('c0575e11-0000-4000-8000-000000000004',
        'c0570000-0000-4000-8000-000000000000', 'COGS Cheese Toast','COGS-TOAST', 10);

-- Recipes. COGS Bare Item deliberately has NONE: an item with no recipe must be
-- recorded as uncosted, never as costing nothing.
INSERT INTO public.bill_of_materials
    (organization_id, sellable_item_id, raw_item_id, quantity_required)
VALUES ('c0570000-0000-4000-8000-000000000000',
        'c0575e11-0000-4000-8000-000000000001', 'c057f00d-0000-4000-8000-000000000001', 1),
       ('c0570000-0000-4000-8000-000000000000',
        'c0575e11-0000-4000-8000-000000000003', 'c057f00d-0000-4000-8000-000000000002', 4),
       ('c0570000-0000-4000-8000-000000000000',
        'c0575e11-0000-4000-8000-000000000004', 'c057f00d-0000-4000-8000-000000000002', 2);

-- Stock. The CHEAP patty lot expires first, so FIFO must consume it first: a
-- sale of 8 costs 5x3.00 + 3x5.00 = 30.00, where a weighted average would say
-- 8 x 4.3333 = 34.67. The assertions pin the exact figure.
INSERT INTO public.inventory_batches
    (organization_id, raw_item_id, quantity_received, quantity_remaining,
     cost_at_purchase, expiry_date)
VALUES ('c0570000-0000-4000-8000-000000000000', 'c057f00d-0000-4000-8000-000000000001',
        5,  5,  3.00, now() + interval '2 days'),
       ('c0570000-0000-4000-8000-000000000000', 'c057f00d-0000-4000-8000-000000000001',
        10, 10, 5.00, now() + interval '9 days'),
       ('c0570000-0000-4000-8000-000000000000', 'c057f00d-0000-4000-8000-000000000002',
        100, 100, 0.50, now() + interval '30 days');

SELECT 'cogs_fixture: seeded' AS result;
