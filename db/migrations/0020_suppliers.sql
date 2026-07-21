-- ============================================================================
-- Migration 0020: Record who supplied each stock lot
-- Mosaiz Mundo ERP
--
-- Every lot already carries what it cost (cost_at_purchase, 0005) — the system
-- knows the price of everything it bought and nothing about who sold it. So
-- "which supplier is raising prices", "who do we actually buy chicken from",
-- and "is this delivery dearer than the last one from the same place" are all
-- unanswerable, even though the money data is already there.
--
-- This adds suppliers and attributes each lot to one.
--
-- ATTRIBUTION IS OPTIONAL, and stays optional. inventory_batches.supplier_id
-- is nullable because:
--   * every lot recorded before this migration genuinely has no supplier, and
--     back-filling a guess would invent purchasing history that never happened;
--   * a stocktake true-up lot (0007/0019) is found stock, not a purchase — no
--     supplier exists to name;
--   * a restaurant taking a cash delivery mid-service should be able to record
--     the stock now and attribute it later, rather than being blocked.
-- Price comparisons therefore report only attributed lots, and say so.
--
-- SUPPLIERS ARE DEACTIVATED, NOT DELETED. Lots reference them, and those
-- references are historical fact: deleting a supplier you stopped using in
-- March would erase the record of what March cost. is_active hides them from
-- the pickers while every past lot keeps its attribution — so the app role gets
-- no DELETE grant at all, which also means no FOR ALL policy gap to close (the
-- trap 0014 and 0019 each had to handle).
--
-- Depends on: 0005 (inventory_batches), 0010 (role predicates), 0001 (app.set_updated_at)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The suppliers themselves.
-- ----------------------------------------------------------------------------
CREATE TABLE public.suppliers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id),
    name            text NOT NULL CHECK (length(btrim(name)) > 0),
    -- Free-form and optional: a corner-shop supplier may be a phone number and
    -- nothing else, and demanding structured contact details would push users
    -- into typing junk to get past the form.
    contact_name    text,
    phone           text,
    notes           text,
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- One name per organization, so "Cairo Foods" cannot be entered twice and
    -- split its own price history in two.
    CONSTRAINT suppliers_organization_id_name_key UNIQUE (organization_id, name),
    -- The project's composite-FK convention: lets a child row prove it points
    -- at a supplier in its OWN organization.
    CONSTRAINT suppliers_id_organization_id_key UNIQUE (id, organization_id)
);

COMMENT ON TABLE public.suppliers IS
    'Who stock is bought from. Deactivated rather than deleted (0020): lots reference suppliers, and that attribution is historical fact.';

CREATE TRIGGER trg_suppliers_updated_at
    BEFORE UPDATE ON public.suppliers
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Tenant isolation and role gating, per the standing convention: ENABLE (not
--    FORCE), a permissive org-membership policy, and RESTRICTIVE gates for the
--    writes. Reads stay open — an accountant reviewing what was paid needs to
--    see who it was paid to.
-- ----------------------------------------------------------------------------
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.suppliers
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

CREATE POLICY require_admin_insert ON public.suppliers
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.suppliers
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

-- No DELETE grant: deactivation is the delete. See the header.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON public.suppliers TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. The link from a lot to its supplier.
--
--    The composite FK is the point: (supplier_id, organization_id) referencing
--    (id, organization_id) makes it structurally impossible to attribute a lot
--    to another tenant's supplier, rather than relying on the API to check.
--    NULL is permitted (see the header) and a composite FK with a NULL column
--    is simply not enforced, which is the behaviour wanted here.
-- ----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
    ADD COLUMN supplier_id uuid;

ALTER TABLE public.inventory_batches
    ADD CONSTRAINT inventory_batches_supplier_fkey
    FOREIGN KEY (supplier_id, organization_id)
    REFERENCES public.suppliers (id, organization_id);

COMMENT ON COLUMN public.inventory_batches.supplier_id IS
    'Who this lot was bought from, when known (0020). NULL for lots recorded before suppliers existed, for stocktake true-up lots (found stock, not a purchase), and for deliveries attributed later.';

-- Supports both "what has this supplier delivered" and the per-ingredient price
-- history, which filters by item and groups by supplier.
CREATE INDEX inventory_batches_supplier_idx
    ON public.inventory_batches (supplier_id, raw_item_id, received_at DESC);

COMMIT;
