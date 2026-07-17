-- ---------------------------------------------------------------------------
-- db/seed.sql — LOCAL DEV seed (NOT a migration; not applied by CI).
-- Run as the postgres owner (bypasses RLS since policies are ENABLE, not FORCE):
--   psql "<admin_url>" -f db/seed.sql
--
-- Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING, safe to re-run.
-- Seeds into the org that GET /api/me resolves for the existing owner
-- (cashier@mosaizmundo.com), so the POS menu actually shows these items.
-- ---------------------------------------------------------------------------
BEGIN;

-- 1) Organization — realistic restaurant profile (keeps the id/slug the owner
--    is already a member of; upsert makes this self-contained on a fresh DB).
INSERT INTO public.organizations (id, name, slug, plan_tier)
VALUES ('123e4567-e89b-12d3-a456-426614174000', 'مطعم موزاييك موندو', 'mosaiz-mundo-alpha', 'basic')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 2) Menu / sellable items (name + price + sku; category/image are not columns
--    in this schema, and the POS renders an emoji placeholder client-side).
INSERT INTO public.sellable_items (id, organization_id, name, sku, price) VALUES
  ('5e11ab1e-0000-4000-8000-000000000001', '123e4567-e89b-12d3-a456-426614174000', 'شاورما فراخ',      'SHW-CHK',  75.00),
  ('5e11ab1e-0000-4000-8000-000000000002', '123e4567-e89b-12d3-a456-426614174000', 'برجر لحم',         'BRG-BEEF', 95.00),
  ('5e11ab1e-0000-4000-8000-000000000003', '123e4567-e89b-12d3-a456-426614174000', 'بيتزا مارجريتا',   'PZA-MARG', 120.00),
  ('5e11ab1e-0000-4000-8000-000000000004', '123e4567-e89b-12d3-a456-426614174000', 'كشري',             'KOSHARI',  45.00),
  ('5e11ab1e-0000-4000-8000-000000000005', '123e4567-e89b-12d3-a456-426614174000', 'عصير مانجو',       'JUC-MNG',  35.00),
  ('5e11ab1e-0000-4000-8000-000000000006', '123e4567-e89b-12d3-a456-426614174000', 'مياه معدنية',      'WATER',    10.00)
ON CONFLICT (id) DO NOTHING;

-- 3) Staff — mock employee profiles (users are id+email only; the role lives on
--    the membership). These are NOT real Supabase accounts, so they can't log in
--    yet — they exist to exercise role-based access control later.
INSERT INTO public.users (id, email) VALUES
  ('5aff0000-0000-4000-8000-000000000001', 'manager@mosaizmundo.com'),
  ('5aff0000-0000-4000-8000-000000000002', 'cashier2@mosaizmundo.com'),
  ('5aff0000-0000-4000-8000-000000000003', 'waiter@mosaizmundo.com')
ON CONFLICT (id) DO NOTHING;

-- Roles are constrained to: owner, regional_manager, branch_manager,
-- accountant, cashier, staff.
INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active) VALUES
  ('123e4567-e89b-12d3-a456-426614174000', '5aff0000-0000-4000-8000-000000000001', 'branch_manager', true),
  ('123e4567-e89b-12d3-a456-426614174000', '5aff0000-0000-4000-8000-000000000002', 'cashier',        true),
  ('123e4567-e89b-12d3-a456-426614174000', '5aff0000-0000-4000-8000-000000000003', 'staff',          true)
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- 4) Raw ingredients, with per-item reorder thresholds (0009). Deliberately
--    mixed so the dashboard shows every state: healthy, low, and out.
INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure, reorder_threshold) VALUES
  ('caff0000-0000-4000-8000-000000000001', '123e4567-e89b-12d3-a456-426614174000', 'دجاج',            'جرام', 2000),
  ('caff0000-0000-4000-8000-000000000002', '123e4567-e89b-12d3-a456-426614174000', 'لحم مفروم',       'جرام', 1500),
  ('caff0000-0000-4000-8000-000000000003', '123e4567-e89b-12d3-a456-426614174000', 'خبز عربي',        'قطعة', 20),
  ('caff0000-0000-4000-8000-000000000004', '123e4567-e89b-12d3-a456-426614174000', 'خبز برجر',        'قطعة', 20),
  ('caff0000-0000-4000-8000-000000000005', '123e4567-e89b-12d3-a456-426614174000', 'جبنة موتزاريلا',  'جرام', 1000),
  ('caff0000-0000-4000-8000-000000000006', '123e4567-e89b-12d3-a456-426614174000', 'طماطم',           'جرام', 1000),
  ('caff0000-0000-4000-8000-000000000007', '123e4567-e89b-12d3-a456-426614174000', 'دقيق',            'جرام', 3000),
  ('caff0000-0000-4000-8000-000000000008', '123e4567-e89b-12d3-a456-426614174000', 'أرز',             'جرام', 2000),
  ('caff0000-0000-4000-8000-000000000009', '123e4567-e89b-12d3-a456-426614174000', 'عدس',             'جرام', 1000),
  ('caff0000-0000-4000-8000-00000000000a', '123e4567-e89b-12d3-a456-426614174000', 'مانجو',           'جرام', 1500),
  ('caff0000-0000-4000-8000-00000000000b', '123e4567-e89b-12d3-a456-426614174000', 'زجاجة مياه',      'قطعة', 24)
ON CONFLICT (id) DO NOTHING;

-- 5) Bill of materials — THIS is what closes the loop: without these lines a POS
--    sale consumes nothing, which is why inventory never moved before.
INSERT INTO public.bill_of_materials (organization_id, sellable_item_id, raw_item_id, quantity_required) VALUES
  -- شاورما فراخ = دجاج + خبز عربي + طماطم
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000001', 'caff0000-0000-4000-8000-000000000001', 200),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000001', 'caff0000-0000-4000-8000-000000000003', 1),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000001', 'caff0000-0000-4000-8000-000000000006', 50),
  -- برجر لحم = لحم مفروم + خبز برجر + جبنة + طماطم
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000002', 'caff0000-0000-4000-8000-000000000002', 150),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000002', 'caff0000-0000-4000-8000-000000000004', 1),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000002', 'caff0000-0000-4000-8000-000000000005', 20),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000002', 'caff0000-0000-4000-8000-000000000006', 30),
  -- بيتزا مارجريتا = دقيق + جبنة + طماطم
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000003', 'caff0000-0000-4000-8000-000000000007', 250),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000003', 'caff0000-0000-4000-8000-000000000005', 150),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000003', 'caff0000-0000-4000-8000-000000000006', 100),
  -- كشري = أرز + عدس + طماطم
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000004', 'caff0000-0000-4000-8000-000000000008', 150),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000004', 'caff0000-0000-4000-8000-000000000009', 80),
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000004', 'caff0000-0000-4000-8000-000000000006', 60),
  -- عصير مانجو = مانجو
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000005', 'caff0000-0000-4000-8000-00000000000a', 200),
  -- مياه معدنية = زجاجة (resale item)
  ('123e4567-e89b-12d3-a456-426614174000', '5e11ab1e-0000-4000-8000-000000000006', 'caff0000-0000-4000-8000-00000000000b', 1)
ON CONFLICT (organization_id, sellable_item_id, raw_item_id) DO NOTHING;

-- 6) FIFO stock lots. Spread across states on purpose:
--      دجاج      -> healthy, but one lot expires in 3 days (expiring soon)
--      خبز برجر  -> 15 on hand vs a threshold of 20 (LOW)
--      عدس       -> no lot at all (OUT of stock)
--      مانجو     -> below threshold AND expiring in 2 days (both flags)
--      زجاجة مياه -> NULL expiry (non-perishable; must sort last in FIFO)
INSERT INTO public.inventory_batches
  (id, organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase, expiry_date) VALUES
  ('ba7c1000-0000-4000-8000-000000000001', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000001',  5000,  5000, 0.12, now() + interval '20 days'),
  ('ba7c1000-0000-4000-8000-000000000002', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000001',  3000,  3000, 0.13, now() + interval '3 days'),
  ('ba7c1000-0000-4000-8000-000000000003', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000002',  4000,  4000, 0.25, now() + interval '15 days'),
  ('ba7c1000-0000-4000-8000-000000000004', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000003',   100,   100, 2.00, now() + interval '5 days'),
  ('ba7c1000-0000-4000-8000-000000000005', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000004',    15,    15, 3.00, now() + interval '7 days'),
  ('ba7c1000-0000-4000-8000-000000000006', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000005',  2500,  2500, 0.20, now() + interval '10 days'),
  ('ba7c1000-0000-4000-8000-000000000007', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000006',  6000,  6000, 0.03, now() + interval '6 days'),
  ('ba7c1000-0000-4000-8000-000000000008', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000007', 10000, 10000, 0.02, now() + interval '90 days'),
  ('ba7c1000-0000-4000-8000-000000000009', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-000000000008',  8000,  8000, 0.03, now() + interval '120 days'),
  ('ba7c1000-0000-4000-8000-00000000000a', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-00000000000a',   800,   800, 0.08, now() + interval '2 days'),
  ('ba7c1000-0000-4000-8000-00000000000b', '123e4567-e89b-12d3-a456-426614174000', 'caff0000-0000-4000-8000-00000000000b',   120,   120, 3.50, NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;
