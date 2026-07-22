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

SELECT 'cross_tenant_fixture: seeded another organization''s supplier and ingredient' AS result;
