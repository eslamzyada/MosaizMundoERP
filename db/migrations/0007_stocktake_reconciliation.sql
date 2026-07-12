-- ============================================================================
-- Migration 0007: Stocktaking, Advisory Locks & Cart Coalescing
-- Mosaiz Mundo ERP
--
-- Three concurrency/efficiency concerns for the Inventory context:
--
--   * process_pos_checkout now COALESCES the cart — duplicate sellable lines
--     are summed and resolved through the BOM into one deduction per raw
--     ingredient, in a deterministic (raw_item_id) order.
--   * process_inventory_deduction and the new post_stocktake both take the
--     SAME per-raw-item transaction advisory lock, so live sales and stocktake
--     postings serialize instead of racing on inventory_batches.
--   * stocktakes / stocktake_items + app.post_stocktake reconcile a physical
--     count against the ledger: shortfalls -> inventory_deficits, surpluses ->
--     a true-up inventory_batches lot.
--
-- Conventions (CLAUDE.md): organization_id + user_belongs_to_org RLS policy
-- and app.set_updated_at trigger on every operational table; ENABLE (never
-- FORCE) RLS; explicit guarded grants for mosaiz_app_user.
--
-- Depends on: 0005 (inventory_batches), 0006 (raw_inventory_items,
-- bill_of_materials, inventory_deficits, both procedures)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- app.process_inventory_deduction — add the inventory advisory lock.
-- Signature and parameter names are unchanged, so CREATE OR REPLACE keeps the
-- existing EXECUTE grant. The transaction-level lock is taken BEFORE any batch
-- is read/modified; it is the same key post_stocktake uses, so a sale blocks
-- while a stocktake for the same raw item is mid-post (and vice versa).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.process_inventory_deduction(
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

    -- Serialize with stocktake postings on this exact raw item.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || p_raw_item_id::text));

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
        INSERT INTO public.inventory_deficits
            (organization_id, raw_item_id, missing_quantity)
        VALUES (p_organization_id, p_raw_item_id, v_remaining);

        RAISE NOTICE 'inventory deficit recorded: item % short by % unit(s)',
            p_raw_item_id, v_remaining;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- app.process_pos_checkout — coalesce the cart before deducting.
--
-- Duplicate sellable_item_id lines (three separate "Burger" taps) are summed,
-- resolved through the BOM, and aggregated per raw ingredient, so each
-- ingredient is deducted exactly once. Deducting in raw_item_id order gives a
-- consistent advisory-lock acquisition order, so concurrent checkouts touching
-- the same ingredients cannot deadlock. Order/line rows are still recorded
-- verbatim — only the stock deduction is coalesced.
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
    v_ded      record;
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

    -- Retry of an already-processed checkout: silent no-op, no re-deduction.
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

    -- Coalesce: total raw requirement per ingredient across ALL cart lines,
    -- deducted once each, in deterministic lock order.
    FOR v_ded IN
        SELECT bom.raw_item_id,
               SUM(bom.quantity_required * (item ->> 'quantity')::integer) AS total_qty
        FROM jsonb_array_elements(v_items) AS item
        JOIN public.bill_of_materials bom
          ON bom.sellable_item_id = (item ->> 'sellable_item_id')::uuid
         AND bom.organization_id  = v_org_id
        GROUP BY bom.raw_item_id
        ORDER BY bom.raw_item_id
    LOOP
        CALL app.process_inventory_deduction(v_ded.raw_item_id, v_org_id, v_ded.total_qty);
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE app.process_pos_checkout(jsonb) IS
    'Idempotent POS checkout: records order/items then deducts BOM-resolved raw '
    'stock FIFO, coalescing duplicate cart lines into one deduction per '
    'ingredient. SECURITY INVOKER — RLS validates the org.';

-- ----------------------------------------------------------------------------
-- stocktakes — a physical count session
-- ----------------------------------------------------------------------------
CREATE TABLE public.stocktakes (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid        NOT NULL REFERENCES public.organizations (id),
    status           text        NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'posted', 'cancelled')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- Composite target so stocktake_items can prove same-tenant parentage.
    UNIQUE (id, organization_id)
);

COMMENT ON TABLE public.stocktakes IS
    'A physical inventory count. Reconciled against the ledger when posted.';

CREATE TRIGGER trg_stocktakes_updated_at
    BEFORE UPDATE ON public.stocktakes
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.stocktakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.stocktakes
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- ----------------------------------------------------------------------------
-- stocktake_items — one counted line per raw item
-- variance is generated (counted - expected): negative = missing, positive =
-- surplus. organization_id is carried per the Golden Rule (CLAUDE.md).
-- ----------------------------------------------------------------------------
CREATE TABLE public.stocktake_items (
    id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
    stocktake_id       uuid           NOT NULL,
    organization_id    uuid           NOT NULL,
    raw_item_id        uuid           NOT NULL,
    expected_quantity  numeric(10,3)  NOT NULL,
    counted_quantity   numeric(10,3)  NOT NULL DEFAULT 0,
    variance           numeric(10,3)
                       GENERATED ALWAYS AS (counted_quantity - expected_quantity) STORED,
    created_at         timestamptz    NOT NULL DEFAULT now(),
    updated_at         timestamptz    NOT NULL DEFAULT now(),

    UNIQUE (stocktake_id, raw_item_id),
    FOREIGN KEY (stocktake_id, organization_id)
        REFERENCES public.stocktakes (id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (raw_item_id, organization_id)
        REFERENCES public.raw_inventory_items (id, organization_id)
);

CREATE INDEX stocktake_items_stocktake_idx ON public.stocktake_items (stocktake_id);

COMMENT ON TABLE public.stocktake_items IS
    'A counted line: expected (ledger) vs counted (physical); variance drives reconciliation.';

CREATE TRIGGER trg_stocktake_items_updated_at
    BEFORE UPDATE ON public.stocktake_items
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.stocktake_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.stocktake_items
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- ----------------------------------------------------------------------------
-- app.post_stocktake — reconcile a draft count against the ledger.
--
-- SECURITY INVOKER: RLS scopes every row it reads/writes to the caller's org.
-- Takes the SAME per-raw-item advisory lock process_inventory_deduction uses,
-- acquired up front in raw_item_id order so that (a) live sales for these items
-- wait until the posting commits, and (b) concurrent postings cannot deadlock.
-- ----------------------------------------------------------------------------
CREATE PROCEDURE app.post_stocktake(p_stocktake_id uuid)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org    uuid;
    v_status text;
    v_item   record;
BEGIN
    SELECT organization_id, status INTO v_org, v_status
    FROM public.stocktakes
    WHERE id = p_stocktake_id;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'stocktake % not found', p_stocktake_id;
    END IF;
    IF v_status <> 'draft' THEN
        RAISE EXCEPTION 'stocktake % is %; only a draft stocktake can be posted',
            p_stocktake_id, v_status;
    END IF;

    -- Lock every counted item's raw stock, in a deterministic order, for the
    -- rest of this transaction. Held through the UPDATE and the reconciliation
    -- inserts below, then released at COMMIT.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || raw_item_id::text))
    FROM public.stocktake_items
    WHERE stocktake_id = p_stocktake_id
    ORDER BY raw_item_id;

    UPDATE public.stocktakes SET status = 'posted' WHERE id = p_stocktake_id;

    FOR v_item IN
        SELECT raw_item_id, variance
        FROM public.stocktake_items
        WHERE stocktake_id = p_stocktake_id
          AND variance <> 0
    LOOP
        IF v_item.variance < 0 THEN
            -- Missing stock: log the shortfall.
            INSERT INTO public.inventory_deficits
                (organization_id, raw_item_id, missing_quantity)
            VALUES (v_org, v_item.raw_item_id, -v_item.variance);
        ELSE
            -- Found stock: true up the ledger with an adjustment lot. Found
            -- stock has no purchase cost, hence cost_at_purchase 0.
            INSERT INTO public.inventory_batches
                (organization_id, raw_item_id, quantity_received,
                 quantity_remaining, cost_at_purchase, expiry_date, received_at)
            VALUES (v_org, v_item.raw_item_id, v_item.variance,
                    v_item.variance, 0, NULL, now());
        END IF;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE app.post_stocktake(uuid) IS
    'Posts a draft stocktake under per-item advisory locks: shortfalls -> '
    'inventory_deficits, surpluses -> a true-up inventory_batches lot.';

REVOKE ALL ON PROCEDURE app.post_stocktake(uuid) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- Grants for the application role. No DELETE: a stocktake is cancelled via
-- status, never erased.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE
            ON public.stocktakes, public.stocktake_items
            TO mosaiz_app_user;
        GRANT EXECUTE ON PROCEDURE app.post_stocktake(uuid) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
