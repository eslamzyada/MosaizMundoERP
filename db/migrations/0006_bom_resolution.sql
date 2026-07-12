-- ============================================================================
-- Migration 0006: Bill of Materials Resolution & Grand Integration
-- Mosaiz Mundo ERP
--
-- Introduces the raw-ingredient layer and connects the Sales and Inventory
-- contexts so a POS sale automatically draws down warehouse stock:
--
--   * raw_inventory_items   (what the warehouse actually stocks)
--   * inventory_batches      refactored: sellable_item_id -> raw_item_id
--                            (a warehouse receives raw ingredients, not menu
--                            items)
--   * bill_of_materials      (recipe: sellable_item -> raw ingredients + qty)
--   * inventory_deficits      (persistent deficit ledger promised in 0005)
--   * app.process_inventory_deduction  now records a deficit row (not just a
--                            WARNING) and is keyed by raw_item_id + org
--   * app.process_pos_checkout  now resolves each cart line through the BOM
--                            and deducts every raw ingredient FIFO
--
-- Conventions (CLAUDE.md): organization_id + user_belongs_to_org RLS policy
-- and app.set_updated_at trigger on every operational table; ENABLE (never
-- FORCE) RLS; explicit guarded grants for mosaiz_app_user.
--
-- Depends on: 0001 (helpers), 0004 (process_pos_checkout, order_items),
-- 0005 (sellable_items, inventory_batches, process_inventory_deduction)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- raw_inventory_items — the raw ingredients the warehouse stocks
-- ----------------------------------------------------------------------------
CREATE TABLE public.raw_inventory_items (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid        NOT NULL REFERENCES public.organizations (id),
    name             text        NOT NULL CHECK (length(trim(name)) > 0),
    unit_of_measure  text        NOT NULL CHECK (length(trim(unit_of_measure)) > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    UNIQUE (organization_id, name),
    -- Composite target so batches / BOM lines can prove same-tenant references.
    UNIQUE (id, organization_id)
);

COMMENT ON TABLE public.raw_inventory_items IS
    'Raw ingredients (grams, pieces, ...) consumed to produce sellable_items via bill_of_materials.';

CREATE TRIGGER trg_raw_inventory_items_updated_at
    BEFORE UPDATE ON public.raw_inventory_items
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.raw_inventory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.raw_inventory_items
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- ----------------------------------------------------------------------------
-- Refactor inventory_batches: it stocks RAW ingredients, not menu items.
-- Batches carry no rows at migration time, so the re-point is clean.
-- The old FK's auto-generated name is discovered rather than guessed.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_conname text;
BEGIN
    SELECT conname INTO v_conname
    FROM pg_constraint
    WHERE conrelid = 'public.inventory_batches'::regclass
      AND contype  = 'f'
      AND confrelid = 'public.sellable_items'::regclass;
    IF v_conname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.inventory_batches DROP CONSTRAINT %I', v_conname);
    END IF;
END;
$$;

-- Rename propagates automatically to inventory_batches_fifo_idx.
ALTER TABLE public.inventory_batches RENAME COLUMN sellable_item_id TO raw_item_id;

ALTER TABLE public.inventory_batches
    ADD CONSTRAINT inventory_batches_raw_item_fkey
    FOREIGN KEY (raw_item_id, organization_id)
    REFERENCES public.raw_inventory_items (id, organization_id);

COMMENT ON COLUMN public.inventory_batches.raw_item_id IS
    'Raw ingredient this lot stocks (repointed from sellable_item_id in 0006).';

-- ----------------------------------------------------------------------------
-- bill_of_materials — the recipe linking a sellable item to its raw inputs
-- ----------------------------------------------------------------------------
CREATE TABLE public.bill_of_materials (
    id                uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   uuid           NOT NULL,
    sellable_item_id  uuid           NOT NULL,
    raw_item_id       uuid           NOT NULL,
    quantity_required numeric(10,3)  NOT NULL CHECK (quantity_required > 0),
    created_at        timestamptz    NOT NULL DEFAULT now(),
    updated_at        timestamptz    NOT NULL DEFAULT now(),

    -- One recipe line per (sellable, raw) within a tenant.
    UNIQUE (organization_id, sellable_item_id, raw_item_id),
    -- Composite FKs: both ends provably live in bill_of_materials.organization_id.
    FOREIGN KEY (sellable_item_id, organization_id)
        REFERENCES public.sellable_items (id, organization_id),
    FOREIGN KEY (raw_item_id, organization_id)
        REFERENCES public.raw_inventory_items (id, organization_id)
);

CREATE INDEX bill_of_materials_sellable_idx
    ON public.bill_of_materials (sellable_item_id);

COMMENT ON TABLE public.bill_of_materials IS
    'Recipe: how much of each raw ingredient one unit of a sellable item consumes.';

CREATE TRIGGER trg_bill_of_materials_updated_at
    BEFORE UPDATE ON public.bill_of_materials
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.bill_of_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.bill_of_materials
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- ----------------------------------------------------------------------------
-- inventory_deficits — persistent ledger of stock sold beyond recorded supply
-- (the durable form of the WARNING-only signal from 0005)
-- ----------------------------------------------------------------------------
CREATE TABLE public.inventory_deficits (
    id                uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   uuid           NOT NULL,
    raw_item_id       uuid           NOT NULL,
    missing_quantity  numeric(10,3)  NOT NULL CHECK (missing_quantity > 0),
    recorded_at       timestamptz    NOT NULL DEFAULT now(),
    updated_at        timestamptz    NOT NULL DEFAULT now(),

    FOREIGN KEY (raw_item_id, organization_id)
        REFERENCES public.raw_inventory_items (id, organization_id)
);

CREATE INDEX inventory_deficits_org_item_idx
    ON public.inventory_deficits (organization_id, raw_item_id);

COMMENT ON TABLE public.inventory_deficits IS
    'One row per checkout that consumed more of a raw item than the ledger held.';

CREATE TRIGGER trg_inventory_deficits_updated_at
    BEFORE UPDATE ON public.inventory_deficits
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.inventory_deficits ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.inventory_deficits
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- ----------------------------------------------------------------------------
-- app.process_inventory_deduction — FIFO consumption, now deficit-recording.
--
-- Signature change (raw_item_id + explicit organization_id) requires DROP +
-- CREATE: CREATE OR REPLACE cannot alter a routine's argument list, and the
-- old (uuid, numeric) form referenced the now-renamed column.
--
-- Still SECURITY INVOKER: RLS scopes every batch and the deficit insert to the
-- caller's org. The org is passed in (not derived) so a full deficit — zero
-- batches at all — can still be recorded against the right tenant.
-- ----------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS app.process_inventory_deduction(uuid, numeric);

CREATE PROCEDURE app.process_inventory_deduction(
    p_raw_item_id        uuid,
    p_organization_id    uuid,
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
    IF p_quantity_to_deduct IS NULL OR p_quantity_to_deduct <= 0 THEN
        RAISE EXCEPTION 'quantity_to_deduct must be positive (got %)', p_quantity_to_deduct;
    END IF;

    -- Oldest-expiry-first, then oldest-received-first; NULLS LAST so undated
    -- lots go last. FOR UPDATE serializes concurrent cashiers on the lot rows
    -- in a consistent order (no lost updates, no deadlock).
    FOR v_batch IN
        SELECT id, quantity_remaining
        FROM public.inventory_batches
        WHERE raw_item_id = p_raw_item_id
          AND organization_id = p_organization_id
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
        -- Recorded stock is insufficient. Persist the shortfall and carry on:
        -- an INSERT does not abort the enclosing checkout the way an EXCEPTION
        -- would, so the cashier can still complete the sale (docs/pos_offline.md §3).
        INSERT INTO public.inventory_deficits
            (organization_id, raw_item_id, missing_quantity)
        VALUES (p_organization_id, p_raw_item_id, v_remaining);

        RAISE NOTICE 'inventory deficit recorded: item % short by % unit(s)',
            p_raw_item_id, v_remaining;
    END IF;
END;
$$;

COMMENT ON PROCEDURE app.process_inventory_deduction(uuid, uuid, numeric) IS
    'FIFO raw-stock deduction (expiry ASC NULLS LAST, then received ASC). On '
    'shortfall it writes an inventory_deficits row instead of raising, so a '
    'lagging warehouse never rolls back a checkout.';

REVOKE ALL ON PROCEDURE app.process_inventory_deduction(uuid, uuid, numeric) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- app.process_pos_checkout — now the integration point.
-- On a fresh (non-retry) order it resolves each cart line through the BOM and
-- deducts every raw ingredient FIFO. Parameter list is unchanged, so
-- CREATE OR REPLACE is fine (and it keeps the existing grant).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.process_pos_checkout(payload jsonb)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org_id   uuid    := (payload ->> 'organization_id')::uuid;
    v_coid     uuid    := (payload ->> 'client_offline_id')::uuid;
    v_total    numeric := (payload ->> 'total_amount')::numeric;
    v_items    jsonb   := payload -> 'items';
    v_order_id uuid;
    v_line     record;
    v_bom      record;
BEGIN
    IF v_org_id IS NULL OR v_coid IS NULL OR v_total IS NULL THEN
        RAISE EXCEPTION
            'checkout payload must include organization_id, client_offline_id and total_amount';
    END IF;
    IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array'
       OR jsonb_array_length(v_items) = 0 THEN
        RAISE EXCEPTION 'checkout payload must include a non-empty items array';
    END IF;

    INSERT INTO public.orders (organization_id, client_offline_id, total_amount)
    VALUES (v_org_id, v_coid, v_total)
    ON CONFLICT (organization_id, client_offline_id) DO NOTHING
    RETURNING id INTO v_order_id;

    -- Retry of an already-processed checkout (docs/pos_offline.md §1):
    -- succeed silently, insert nothing, deduct nothing, never double-book.
    IF v_order_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.order_items
        (order_id, organization_id, sellable_item_id, quantity, unit_price)
    SELECT
        v_order_id,
        v_org_id,
        (item ->> 'sellable_item_id')::uuid,
        (item ->> 'quantity')::integer,
        (item ->> 'unit_price')::numeric
    FROM jsonb_array_elements(v_items) AS item;

    -- Grand integration: for each cart line, expand the recipe and draw down
    -- each raw ingredient (quantity_required x line quantity) from the
    -- warehouse, FIFO. Items without a BOM (e.g. a bottled drink) simply
    -- resolve to zero components and deduct nothing.
    FOR v_line IN
        SELECT (item ->> 'sellable_item_id')::uuid AS sellable_item_id,
               (item ->> 'quantity')::integer      AS quantity
        FROM jsonb_array_elements(v_items) AS item
    LOOP
        FOR v_bom IN
            SELECT raw_item_id, quantity_required
            FROM public.bill_of_materials
            WHERE sellable_item_id = v_line.sellable_item_id
              AND organization_id  = v_org_id
        LOOP
            CALL app.process_inventory_deduction(
                v_bom.raw_item_id,
                v_org_id,
                v_bom.quantity_required * v_line.quantity);
        END LOOP;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE app.process_pos_checkout(jsonb) IS
    'Idempotent POS checkout: inserts the order/items then deducts BOM-resolved '
    'raw stock FIFO. Retrying the same (organization_id, client_offline_id) is a '
    'silent no-op. SECURITY INVOKER — RLS validates the org.';

-- ----------------------------------------------------------------------------
-- Grants for the application role. No DELETE anywhere: catalog/recipes are
-- deactivated not erased; batches and deficits are ledger rows.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE
            ON public.raw_inventory_items, public.bill_of_materials
            TO mosaiz_app_user;
        -- Deficits are an append-only audit trail: insert + read only.
        GRANT SELECT, INSERT ON public.inventory_deficits TO mosaiz_app_user;
        GRANT EXECUTE ON PROCEDURE app.process_inventory_deduction(uuid, uuid, numeric)
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
