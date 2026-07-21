-- ============================================================================
-- Supplier fixture (0020) — runs as postgres.
--
-- Seeds ONE supplier belonging to a DIFFERENT organization than the RBAC
-- fixture's, so supplier_verification can prove a lot cannot be attributed to
-- another tenant's supplier.
--
-- It has to be seeded as the superuser: the app role can only insert a supplier
-- into an organization it belongs to (the permissive policy), so the test user
-- is structurally unable to create the very row the cross-tenant assertion
-- needs. A test that seeded it as itself would be testing nothing.
--
-- Run order: after rbac_fixture.sql, before supplier_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

INSERT INTO public.suppliers (id, organization_id, name)
SELECT '5099117e-000f-400f-800f-00000000000f',
       o.id,
       'Foreign Tenant Supplier'
FROM public.organizations o
WHERE o.slug = 'ci-bistro-cairo';

SELECT 'supplier_fixture: seeded a supplier in another organization' AS result;
