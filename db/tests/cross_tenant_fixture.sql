-- ============================================================================
-- Cross-tenant fixture — runs as postgres.
--
-- Seeds rows belonging to a DIFFERENT organization than the RBAC fixture's, so
-- the supplier and purchase-order suites can prove that a composite FK refuses
-- to reference another tenant's data.
--
-- These have to be seeded as the superuser. The app role can only insert into
-- an organization it belongs to, and RLS hides other tenants' rows from it
-- entirely — so the test user is structurally unable to create, or even see,
-- the very rows the cross-tenant assertions need. A suite that seeded them as
-- itself would be asserting nothing.
--
-- Run order: after rbac_fixture.sql, before supplier_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

-- A supplier owned by the other organization.
INSERT INTO public.suppliers (id, organization_id, name)
SELECT '5099117e-000f-400f-800f-00000000000f', o.id, 'Foreign Tenant Supplier'
FROM public.organizations o
WHERE o.slug = 'ci-bistro-cairo';

-- An ingredient owned by the other organization, so a purchase order line can
-- try (and fail) to reference it.
INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
SELECT 'a11cf00d-000f-400f-800f-00000000000f', o.id, 'Foreign Tenant Ingredient', 'grams'
FROM public.organizations o
WHERE o.slug = 'ci-bistro-cairo';

-- An ORDER owned by the other organization, so the open-order suite has
-- something real to be refused. Its id is FIXED and quoted literally there:
-- the app role cannot look this row up, because RLS hides other tenants' orders
-- from it entirely — a suite that SELECTed for it would find nothing, skip
-- itself, and report a pass. That is exactly what happened before this row
-- existed.
INSERT INTO public.orders (id, organization_id, client_offline_id, status, total_amount)
SELECT '0d4e4000-000f-400f-800f-00000000000f', o.id,
       '0d4e4000-000f-400f-800f-0000000000ff', 'open', 0
FROM public.organizations o
WHERE o.slug = 'ci-bistro-cairo';

-- A PRINTER owned by the other organization. Same reasoning as the order: the
-- printer suite quotes this id literally, because a row it cannot see is a row
-- it cannot look up, and a lookup that finds nothing asserts nothing.
INSERT INTO public.printers (id, organization_id, name, role, host)
SELECT '9111e400-000f-400f-800f-00000000000f', o.id, 'Foreign Tenant Printer',
       'kitchen', '10.99.99.99'
FROM public.organizations o
WHERE o.slug = 'ci-bistro-cairo';

-- BRANDING owned by the other organization (0032). Without this row the
-- preferences suite's cross-tenant count has nothing to find, so it reports
-- zero whether or not the policy holds — the same vacuous pass that hid the
-- cross-tenant order check until a real row existed.
INSERT INTO public.organization_branding (organization_id, display_name)
SELECT o.id, 'Foreign Tenant Restaurant'
FROM public.organizations o
WHERE o.slug = 'ci-bistro-cairo';

-- These are all INSERT ... SELECT ... WHERE slug = '...', which insert ZERO
-- rows — silently, without error — if that organization is ever missing. Every
-- cross-tenant assertion downstream would then be testing against nothing and
-- passing. Checked here because here is the only place with the visibility to
-- check it.
DO $$
DECLARE
    missing text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.suppliers
                   WHERE id = '5099117e-000f-400f-800f-00000000000f') THEN
        missing := missing || 'supplier'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.raw_inventory_items
                   WHERE id = 'a11cf00d-000f-400f-800f-00000000000f') THEN
        missing := missing || 'ingredient'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.orders
                   WHERE id = '0d4e4000-000f-400f-800f-00000000000f') THEN
        missing := missing || 'order'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.printers
                   WHERE id = '9111e400-000f-400f-800f-00000000000f') THEN
        missing := missing || 'printer'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organization_branding b
                   JOIN public.organizations o ON o.id = b.organization_id
                   WHERE o.slug = 'ci-bistro-cairo') THEN
        missing := missing || 'branding'; END IF;

    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION
            'cross-tenant fixture seeded nothing for %: the ci-bistro-cairo '
            'organization is missing, and every cross-tenant assertion would '
            'have passed against an absent row', array_to_string(missing, ', ');
    END IF;
END;
$$;

SELECT 'cross_tenant_fixture: seeded another organization''s supplier, ingredient, order, printer and branding' AS result;
