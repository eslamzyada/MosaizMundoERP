-- ============================================================================
-- Migration 0014: Allow removing a recipe line (bill_of_materials DELETE)
-- Mosaiz Mundo ERP
--
-- Editing a recipe means adding an ingredient, changing how much of it a dish
-- consumes, AND taking an ingredient back out. The first two already work: the
-- app role holds INSERT/SELECT/UPDATE on bill_of_materials, gated to admins by
-- the 0010 RESTRICTIVE policies (require_admin_insert / require_admin_update).
-- The third does not — the app role was never granted DELETE, so removing a
-- line is impossible through the API.
--
-- The grant alone would be a privilege hole. bill_of_materials carries the
-- PERMISSIVE user_belongs_to_org policy FOR ALL, which covers DELETE, and 0010
-- added RESTRICTIVE gates only for INSERT and UPDATE. So a bare GRANT DELETE
-- would let ANY member of the organization — a cashier, an accountant — delete
-- recipe lines, silently changing food cost and stopping the deduction of that
-- ingredient at checkout. The grant and the RESTRICTIVE gate ship together.
--
-- Deleting a line is not retroactive: sale_items and inventory_batches record
-- what already happened, so past sales and their deductions are untouched. Only
-- future checkouts stop consuming the removed ingredient.
--
-- Depends on: 0005 (bill_of_materials), 0010 (app.user_can_administer)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The missing privilege. Guarded DO block, per the 0001-0003 convention:
--    the role exists in every real environment but not necessarily in a bare
--    scratch database.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT DELETE ON public.bill_of_materials TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Gate it to admins, mirroring require_admin_insert / require_admin_update
--    from 0010. RESTRICTIVE, so it ANDs with the permissive org-membership
--    policy: you must belong to the organization AND be able to administer it.
--    DELETE has no WITH CHECK — USING alone decides which rows may be removed.
-- ----------------------------------------------------------------------------
CREATE POLICY require_admin_delete ON public.bill_of_materials
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

COMMENT ON TABLE public.bill_of_materials IS
    'Recipe lines: how much of each raw ingredient one sellable item consumes. Admin-only for INSERT/UPDATE/DELETE (0010, 0014); readable by any member of the organization.';

COMMIT;
