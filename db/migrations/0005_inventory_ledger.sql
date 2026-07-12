-- ============================================================================
-- Migration 0005: Warehouse Ledger (Inventory Context)
-- Mosaiz Mundo ERP
--
-- Creates:
--   * sellable_items    (the catalog; UNIQUE (organization_id, sku))
--   * inventory_batches (FIFO stock lots: cost_at_purchase, expiry_date)
--   * app.process_inventory_deduction(sellable_item_id, quantity) — FIFO
--     deduction that logs a deficit instead of crashing the sale
--   * the deferred FK from order_items.sellable_item_id -> sellable_items
--
-- Conventions (CLAUDE.md): organization_id + user_belongs_to_org RLS policy
-- and app.set_updated_at trigger on every operational table; ENABLE (never
-- FORCE) RLS; explicit guarded grants for mosaiz_app_user.
--
-- Depends on: 0001 (organizations, app.* helpers), 0004 (order_items)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- sellable_items — the menu / catalog
-- ----------------------------------------------------------------------------
CREATE TABLE public.sellable_items (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid        NOT NULL REFERENCES public.organizations (id),
    name             text        NOT NULL CHECK (length(trim(name)) > 0),
    sku              text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- SKU is unique per tenant when present. NULLs are distinct in a UNIQUE
    -- constraint, so items without a SKU are simply unconstrained here.
    UNIQUE (organization_id, sku),
    -- Composite target so child rows (order_items, inventory_batches) can prove
    -- via FK that they reference a catalog item in their OWN organization.
    UNIQUE (id, organization_id)
);

COMMENT ON TABLE public.sellable_items IS
    'Per-tenant catalog of sellable items. Referenced by order_items and inventory_batches.';

CREATE TRIGGER trg_sellable_items_updated_at
    BEFORE UPDATE ON public.sellable_items
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- The deferred FK from 0004: an order line now provably references a real
-- catalog item in the SAME organization (composite, mirroring the orders FK).
-- Safe to add: order_items carries no rows at migration time (tests run after).
ALTER TABLE public.order_items
    ADD CONSTRAINT order_items_sellable_item_fkey
    FOREIGN KEY (sellable_item_id, organization_id)
    REFERENCES public.sellable_items (id, organization_id);

-- ----------------------------------------------------------------------------
-- inventory_batches — accounting-grade stock lots (docs/pos_offline.md §3)
-- ----------------------------------------------------------------------------
CREATE TABLE public.inventory_batches (
    id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid           NOT NULL,
    sellable_item_id    uuid           NOT NULL,
    quantity_received   numeric(10,3)  NOT NULL CHECK (quantity_received > 0),
    -- Never negative, never more than what came in. FIFO deduction drives this
    -- toward 0; a stocktake may adjust it, but never outside these bounds.
    quantity_remaining  numeric(10,3)  NOT NULL
                        CHECK (quantity_remaining >= 0
                               AND quantity_remaining <= quantity_received),
    cost_at_purchase    numeric(10,2)  NOT NULL CHECK (cost_at_purchase >= 0),
    expiry_date         timestamptz,
    received_at         timestamptz    NOT NULL DEFAULT now(),
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now(),

    FOREIGN KEY (sellable_item_id, organization_id)
        REFERENCES public.sellable_items (id, organization_id)
);

-- Serves the FIFO scan directly: oldest-expiry-first within an item, and the
-- partial predicate skips fully-drained lots.
CREATE INDEX inventory_batches_fifo_idx
    ON public.inventory_batches (sellable_item_id, expiry_date, received_at)
    WHERE quantity_remaining > 0;

COMMENT ON TABLE public.inventory_batches IS
    'Stock lots consumed oldest-expiry-first. quantity_remaining is the live balance.';
COMMENT ON COLUMN public.inventory_batches.expiry_date IS
    'Nullable. NULL-expiry lots are consumed only after all dated lots (NULLS LAST).';

CREATE TRIGGER trg_inventory_batches_updated_at
    BEFORE UPDATE ON public.inventory_batches
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- Row Level Security — standard user_belongs_to_org on both tables
-- ----------------------------------------------------------------------------
ALTER TABLE public.sellable_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches  ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.sellable_items
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

CREATE POLICY user_belongs_to_org ON public.inventory_batches
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- ----------------------------------------------------------------------------
-- app.process_inventory_deduction — FIFO consumption
--
-- SECURITY INVOKER (default), like process_pos_checkout: it runs inside the
-- caller's session so RLS scopes every batch it reads/writes to the caller's
-- organization automatically — no manual organization_id filter, and no org
-- parameter is needed (docs/rls_policies.md agent instruction).
--
-- Deficit rule (docs/pos_offline.md §3): if recorded stock is exhausted before
-- the full quantity is deducted, RAISE WARNING and return. A WARNING is logged
-- but is NOT an error, so it never aborts the enclosing POS checkout
-- transaction — the cashier can always complete the sale even when warehouse
-- data entry lags.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.process_inventory_deduction(
    p_sellable_item_id   uuid,
    p_quantity_to_deduct numeric
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_remaining numeric := p_quantity_to_deduct;
    v_take      numeric;
    v_batch     record;
BEGIN
    -- A non-positive deduction is a caller bug, not a stock condition; reject
    -- it outright rather than silently absorbing it as a "deficit".
    IF p_quantity_to_deduct IS NULL OR p_quantity_to_deduct <= 0 THEN
        RAISE EXCEPTION 'quantity_to_deduct must be positive (got %)', p_quantity_to_deduct;
    END IF;

    -- Oldest-expiry-first, then oldest-received-first. NULLS LAST means
    -- undated lots are consumed only after every dated lot. FOR UPDATE locks
    -- the lots in this deterministic order so concurrent cashiers serialize
    -- on the batch rows (no lost updates, no deadlock — consistent order).
    FOR v_batch IN
        SELECT id, quantity_remaining
        FROM public.inventory_batches
        WHERE sellable_item_id = p_sellable_item_id
          AND quantity_remaining > 0
        ORDER BY expiry_date ASC NULLS LAST, received_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;

        v_take := LEAST(v_batch.quantity_remaining, v_remaining);

        UPDATE public.inventory_batches
        SET quantity_remaining = quantity_remaining - v_take
        WHERE id = v_batch.id;

        v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
        -- Stock recorded in the ledger is insufficient. Log the shortfall and
        -- carry on — do NOT raise, or the parent checkout would roll back.
        RAISE WARNING
            'inventory deficit: item % short by % unit(s); sold beyond recorded stock',
            p_sellable_item_id, v_remaining;
    END IF;
END;
$$;

COMMENT ON PROCEDURE app.process_inventory_deduction(uuid, numeric) IS
    'FIFO stock deduction (expiry ASC NULLS LAST, then received ASC). Logs a '
    'deficit via WARNING instead of raising, so it never rolls back a checkout.';

REVOKE ALL ON PROCEDURE app.process_inventory_deduction(uuid, numeric) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- Grants for the application role. No DELETE: the catalog is deactivated, not
-- erased, and inventory lots are ledger rows (drained to 0, never removed).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE
            ON public.sellable_items, public.inventory_batches
            TO mosaiz_app_user;
        GRANT EXECUTE ON PROCEDURE app.process_inventory_deduction(uuid, numeric)
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
