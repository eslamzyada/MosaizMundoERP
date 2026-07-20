-- ============================================================================
-- Migration 0017: Record which stock each sale actually consumed
-- Mosaiz Mundo ERP
--
-- The FIFO walk in process_inventory_deduction_costed knows exactly which lots
-- it drew from, how much of each, and what each cost — and then throws all of
-- it away, mutating quantity_remaining in place. Nothing links a sale to the
-- stock it consumed.
--
-- That gap has two consequences:
--   * A void cannot restore stock accurately. The only way to work out what to
--     put back would be to re-read the dish's CURRENT recipe, which is wrong for
--     any dish whose recipe changed since the sale — and recipes are now edited
--     from the admin, so that is likely rather than theoretical.
--   * There is no lot traceability. "Which orders used this batch?" is the first
--     question asked in a food-safety recall, and it is unanswerable today.
--
-- This adds the missing ledger and writes it during checkout.
--
-- GRAIN: one row per (order, raw item, lot) — NOT per order line.
-- Deduction is coalesced per ingredient across the whole cart (0007), so the
-- draw genuinely happens at order level; one lot's 500g may serve three
-- different lines. Recording per line would mean splitting that by a rule
-- nobody observed — inventing precision the deduction never had. Order level is
-- what actually happened, and it is enough to reverse a void and to answer a
-- recall.
--
-- Shortfalls are deliberately NOT recorded here. Stock that was never in the
-- system cannot appear in a ledger of stock consumed; inventory_deficits (0013)
-- already carries that, and duplicating it would invite the two disagreeing.
--
-- Depends on: 0005 (batches), 0015 (the costed FIFO procedure this extends)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The ledger.
-- ----------------------------------------------------------------------------
CREATE TABLE public.inventory_consumption (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    order_id        uuid NOT NULL,
    raw_item_id     uuid NOT NULL,
    -- Which lot the stock came out of. Kept for traceability, so this survives
    -- even though quantity_remaining on that lot has already moved on.
    batch_id        uuid NOT NULL REFERENCES public.inventory_batches (id),
    quantity        numeric(10, 3) NOT NULL CHECK (quantity > 0),
    -- The lot's cost_at_purchase, copied at the moment of consumption: what this
    -- stock cost is a historical fact and must not follow the lot if it changes.
    unit_cost       numeric(10, 2) NOT NULL CHECK (unit_cost >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT inventory_consumption_order_fkey
        FOREIGN KEY (order_id, organization_id)
        REFERENCES public.orders (id, organization_id) ON DELETE CASCADE,
    CONSTRAINT inventory_consumption_raw_item_fkey
        FOREIGN KEY (raw_item_id, organization_id)
        REFERENCES public.raw_inventory_items (id, organization_id)
);

-- The two questions this table exists to answer.
CREATE INDEX inventory_consumption_order_idx
    ON public.inventory_consumption (order_id);
CREATE INDEX inventory_consumption_batch_idx
    ON public.inventory_consumption (batch_id);

COMMENT ON TABLE public.inventory_consumption IS
    'Which stock each sale actually consumed: one row per (order, raw item, lot), written by the FIFO walk at checkout (0017). Grain is the order, not the line, because deduction is coalesced per ingredient across the cart.';

CREATE TRIGGER trg_inventory_consumption_updated_at
    BEFORE UPDATE ON public.inventory_consumption
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. Tenant isolation, and the privileges the app role needs.
--    ENABLE, never FORCE — FORCE would break the SECURITY DEFINER helpers.
-- ----------------------------------------------------------------------------
ALTER TABLE public.inventory_consumption ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.inventory_consumption
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Written during checkout, which is SECURITY INVOKER and runs as a CASHIER, so
-- the INSERT is gated to sell-capable roles exactly like the deduction it
-- accompanies. There is no UPDATE or DELETE grant: consumption is a historical
-- record, and rows leave only when their order does (ON DELETE CASCADE).
CREATE POLICY require_sell_insert ON public.inventory_consumption
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_sell(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT ON public.inventory_consumption TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. The FIFO walk now writes what it consumed.
--
--    The procedure gains p_order_id. Adding it with a DEFAULT would leave the
--    old five-argument form callable and make every call ambiguous, so the old
--    signature is dropped and both call sites are updated below. p_order_id is
--    NULL for deductions that are not a sale (the wrapper, and the FIFO
--    assertion suite), and the ledger is only written when it is present —
--    stock consumed outside an order has no order to attribute it to.
-- ----------------------------------------------------------------------------
DROP PROCEDURE app.process_inventory_deduction_costed(uuid, uuid, numeric, numeric, numeric);

CREATE PROCEDURE app.process_inventory_deduction_costed(
    p_raw_item_id           uuid,
    p_organization_id       uuid,
    p_quantity_to_deduct    numeric,
    INOUT p_cost_consumed   numeric,
    INOUT p_quantity_short  numeric,
    p_order_id              uuid
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_remaining numeric := p_quantity_to_deduct;
    v_take      numeric;
    v_batch     record;
BEGIN
    p_cost_consumed  := 0;
    p_quantity_short := 0;

    IF p_quantity_to_deduct IS NULL OR p_quantity_to_deduct <= 0 THEN
        RAISE EXCEPTION 'quantity_to_deduct must be positive (got %)', p_quantity_to_deduct;
    END IF;

    -- Serialize with stocktake postings on this exact raw item.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || p_raw_item_id::text));

    FOR v_batch IN
        SELECT id, quantity_remaining, cost_at_purchase
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

        -- The cost of goods sold: what THIS stock cost, lot by lot.
        p_cost_consumed := p_cost_consumed + (v_take * v_batch.cost_at_purchase);

        -- Remember it, so a void can put back exactly what was taken and a
        -- recall can trace this lot to the orders it went into.
        IF p_order_id IS NOT NULL THEN
            INSERT INTO public.inventory_consumption
                (organization_id, order_id, raw_item_id, batch_id, quantity, unit_cost)
            VALUES (p_organization_id, p_order_id, p_raw_item_id,
                    v_batch.id, v_take, v_batch.cost_at_purchase);
        END IF;

        v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
        -- Sold beyond recorded supply: this part of the sale has no cost basis,
        -- and no lot, so it is recorded as a deficit rather than as consumption.
        p_quantity_short := v_remaining;

        INSERT INTO public.inventory_deficits
            (organization_id, raw_item_id, missing_quantity)
        VALUES (p_organization_id, p_raw_item_id, v_remaining)
        ON CONFLICT (organization_id, raw_item_id) DO UPDATE
            SET missing_quantity =
                public.inventory_deficits.missing_quantity + excluded.missing_quantity;

        RAISE NOTICE 'inventory deficit recorded: item % short by % unit(s)',
            p_raw_item_id, v_remaining;
    END IF;
END;
$$;

COMMENT ON PROCEDURE app.process_inventory_deduction_costed(uuid, uuid, numeric, numeric, numeric, uuid) IS
    'FIFO consumption of one raw ingredient: draws stock down, reports the actual cost of the lots consumed and any shortfall, and records what it took against the order (0017). SECURITY INVOKER.';

-- ----------------------------------------------------------------------------
-- 4. The three-argument wrapper, unchanged in signature, now passing NULL for
--    the order. Callers that are not a sale keep working untouched.
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
    v_cost  numeric := 0;
    v_short numeric := 0;
BEGIN
    CALL app.process_inventory_deduction_costed(
        p_raw_item_id, p_organization_id, p_quantity_to_deduct, v_cost, v_short, NULL);
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Checkout — its CURRENT body (0015), with the single change of passing the
--    order id into the deduction so the ledger is attributed. Validation,
--    pricing, the idempotency gate, coalescing, the deterministic lock order and
--    the cost allocation are all untouched.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.process_pos_checkout(payload jsonb)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org_id   uuid  := (payload ->> 'organization_id')::uuid;
    v_coid     uuid  := (payload ->> 'client_offline_id')::uuid;
    v_items    jsonb := payload -> 'items';
    v_total    numeric;
    v_missing  integer;
    v_order_id uuid;
    v_ded      record;
    v_costs    jsonb := '{}'::jsonb;
    v_cost     numeric;
    v_short    numeric;
BEGIN
    IF v_org_id IS NULL OR v_coid IS NULL THEN
        RAISE EXCEPTION
            'checkout payload must include organization_id and client_offline_id';
    END IF;
    IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array'
       OR jsonb_array_length(v_items) = 0 THEN
        RAISE EXCEPTION 'checkout payload must include a non-empty items array';
    END IF;

    SELECT count(*) FILTER (WHERE s.id IS NULL)
      INTO v_missing
    FROM jsonb_array_elements(v_items) AS item
    LEFT JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org_id;

    IF v_missing > 0 THEN
        RAISE EXCEPTION
            'checkout references % item(s) not available in this organization', v_missing;
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_items) AS item
        WHERE COALESCE((item ->> 'quantity')::integer, 0) <= 0
    ) THEN
        RAISE EXCEPTION 'every checkout line must have a positive quantity';
    END IF;

    SELECT sum(s.price * (item ->> 'quantity')::integer)
      INTO v_total
    FROM jsonb_array_elements(v_items) AS item
    JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org_id;

    INSERT INTO public.orders (organization_id, client_offline_id, total_amount)
    VALUES (v_org_id, v_coid, v_total)
    ON CONFLICT (organization_id, client_offline_id) DO NOTHING
    RETURNING id INTO v_order_id;

    -- Retry of an already-processed checkout: silent no-op. No re-deduction, no
    -- double-counted cost, and no duplicate consumption rows.
    IF v_order_id IS NULL THEN
        RETURN;
    END IF;

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
        v_cost  := 0;
        v_short := 0;

        CALL app.process_inventory_deduction_costed(
            v_ded.raw_item_id, v_org_id, v_ded.total_qty, v_cost, v_short, v_order_id);

        v_costs := v_costs || jsonb_build_object(
            v_ded.raw_item_id::text,
            jsonb_build_object('cost', v_cost, 'short', v_short, 'qty', v_ded.total_qty));
    END LOOP;

    INSERT INTO public.order_items
        (order_id, organization_id, sellable_item_id, quantity, unit_price,
         cost_at_sale, cost_is_complete)
    SELECT
        v_order_id,
        v_org_id,
        (item ->> 'sellable_item_id')::uuid,
        (item ->> 'quantity')::integer,
        s.price,
        COALESCE(c.line_cost, 0),
        COALESCE(c.complete, false)
    FROM jsonb_array_elements(v_items) AS item
    JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org_id
    LEFT JOIN LATERAL (
        SELECT
            SUM(
                (v_costs -> bom.raw_item_id::text ->> 'cost')::numeric
                * (bom.quantity_required * (item ->> 'quantity')::integer)
                / NULLIF((v_costs -> bom.raw_item_id::text ->> 'qty')::numeric, 0)
            ) AS line_cost,
            BOOL_AND(
                COALESCE((v_costs -> bom.raw_item_id::text ->> 'short')::numeric, 0) = 0
            ) AS complete
        FROM public.bill_of_materials bom
        WHERE bom.sellable_item_id = (item ->> 'sellable_item_id')::uuid
          AND bom.organization_id  = v_org_id
    ) c ON true;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Privileges for the replaced procedure.
-- ----------------------------------------------------------------------------
REVOKE ALL ON PROCEDURE
    app.process_inventory_deduction_costed(uuid, uuid, numeric, numeric, numeric, uuid) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON PROCEDURE
            app.process_inventory_deduction_costed(uuid, uuid, numeric, numeric, numeric, uuid)
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
