-- ============================================================================
-- Migration 0010: Role-based authorization
-- Mosaiz Mundo ERP
--
-- Until now `organization_memberships.role` was dead data: written at
-- provisioning, never read. Every active member could do everything — a cashier
-- could receive stock or rewrite a recipe. This makes the role decide.
--
-- DESIGN — additive RESTRICTIVE policies.
--   The existing per-table `user_belongs_to_org` policy is FOR ALL and
--   PERMISSIVE. Permissive policies OR together, so a second permissive policy
--   could only ever *widen* access. RESTRICTIVE policies AND with them instead,
--   so a write must satisfy BOTH: "member of this org" AND "holds a role that
--   may do this". Nothing here drops or rewrites 0001–0009 policies, and SELECT
--   is deliberately untouched — every member (accountant included) still reads
--   everything in their own org.
--
-- DESIGN — why per COMMAND, not per table.
--   process_pos_checkout and process_inventory_deduction are SECURITY INVOKER
--   on purpose (0004/0006: "RLS validates the org"). A cashier's sale therefore
--   executes as the cashier and writes:
--       INSERT orders, INSERT order_items,
--       UPDATE inventory_batches (FIFO draw-down), INSERT inventory_deficits.
--   Gating those tables wholesale would break checkout for the very role that
--   exists to run it. So: INSERT on inventory_batches (receiving stock) is
--   administrative, while UPDATE (selling) is not.
--   post_stocktake is likewise SECURITY INVOKER but is only ever posted by an
--   administrator, so its INSERT of a true-up lot satisfies the admin policy.
--
-- No DELETE policies: the app role holds no DELETE grant on any operational
-- table (0005: lots are ledger rows, the catalog is deactivated not erased).
--
-- Depends on: 0001 (memberships, current_user_id), 0004–0007 (the tables)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Role predicates
--
-- STABLE SECURITY DEFINER SET search_path = '' for the same reason as
-- app.user_belongs_to_org (docs/rls_policies.md §4): the check must read
-- organization_memberships without recursing into that table's own RLS policy.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.user_has_org_role(
    target_organization_id uuid,
    allowed_roles          text[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_memberships m
        WHERE m.organization_id = target_organization_id
          AND m.user_id         = app.current_user_id()
          AND m.is_active
          AND m.role = ANY (allowed_roles)
    );
$$;

COMMENT ON FUNCTION app.user_has_org_role(uuid, text[]) IS
    'True when the session user holds an active membership in the org with one of the given roles.';

-- Named wrappers so the policies below read as intent, and the role lists live
-- in exactly one place.
CREATE OR REPLACE FUNCTION app.user_can_administer(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT app.user_has_org_role(
        target_organization_id,
        ARRAY['owner', 'regional_manager', 'branch_manager']
    );
$$;

COMMENT ON FUNCTION app.user_can_administer(uuid) IS
    'Operational writes: receiving stock, stocktakes, catalog and recipe edits. Excludes accountant (read-only), cashier and staff.';

CREATE OR REPLACE FUNCTION app.user_can_sell(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT app.user_has_org_role(
        target_organization_id,
        ARRAY['owner', 'regional_manager', 'branch_manager', 'cashier', 'staff']
    );
$$;

COMMENT ON FUNCTION app.user_can_sell(uuid) IS
    'May ring up a sale and the stock movement it causes. Everyone except accountant, who is read-only.';

-- ----------------------------------------------------------------------------
-- Catalog, recipes and ingredients — administrative writes only.
-- ----------------------------------------------------------------------------
CREATE POLICY require_admin_insert ON public.raw_inventory_items
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.raw_inventory_items
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_insert ON public.sellable_items
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.sellable_items
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_insert ON public.bill_of_materials
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.bill_of_materials
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

-- ----------------------------------------------------------------------------
-- Stocktakes — counting and reconciling stock is administrative.
-- ----------------------------------------------------------------------------
CREATE POLICY require_admin_insert ON public.stocktakes
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.stocktakes
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_insert ON public.stocktake_items
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.stocktake_items
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

-- ----------------------------------------------------------------------------
-- Inventory lots — the split that keeps checkout working.
--   INSERT = receiving stock / a stocktake true-up  -> administrative.
--   UPDATE = the FIFO draw-down a sale causes       -> anyone who may sell.
-- ----------------------------------------------------------------------------
CREATE POLICY require_admin_insert ON public.inventory_batches
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_sell_update ON public.inventory_batches
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_sell(organization_id))
    WITH CHECK (app.user_can_sell(organization_id));

-- A shortfall is recorded by the sale itself (and by post_stocktake), so it
-- follows the seller, not the administrator. The app role has no UPDATE grant
-- here, so INSERT is the only write to gate.
CREATE POLICY require_sell_insert ON public.inventory_deficits
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_sell(organization_id));

-- ----------------------------------------------------------------------------
-- Orders — writing a sale follows the seller; amending one is administrative.
-- ----------------------------------------------------------------------------
CREATE POLICY require_sell_insert ON public.orders
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_sell(organization_id));

CREATE POLICY require_admin_update ON public.orders
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_sell_insert ON public.order_items
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_sell(organization_id));

CREATE POLICY require_admin_update ON public.order_items
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

-- ----------------------------------------------------------------------------
-- Grants. EXECUTE on functions defaults to PUBLIC (as with
-- app.user_belongs_to_org), but state it explicitly for the app role.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.user_has_org_role(uuid, text[])   TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.user_can_administer(uuid)         TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.user_can_sell(uuid)               TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
