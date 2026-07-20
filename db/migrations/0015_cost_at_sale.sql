-- ============================================================================
-- Migration 0015: Record what each sale actually cost (COGS at checkout)
-- Mosaiz Mundo ERP
--
-- Food cost today is always "as of the stock on hand right now". That answers
-- "what does this dish cost me today" but not "what did we actually make last
-- month" — and it silently rewrites history every time a delivery arrives at a
-- new price. Margin only becomes reportable once the cost of a sale is captured
-- AT the sale.
--
-- What is recorded is the ACTUAL cost of the lots consumed, not an average.
-- process_inventory_deduction already walks the batches FIFO (earliest expiry,
-- then oldest received) and knows what each one cost; this migration simply
-- stops throwing that number away. A sale that eats the last 5 units of a 3.00
-- lot and 5 units of a 5.00 lot cost 40.00, and that is what gets stored.
--
-- Three design points worth stating, because each avoids a real defect:
--
--  1. order_items rows are INSERTED with their cost already computed, rather
--     than inserted and then updated. UPDATE on order_items is gated to admins
--     by the 0010 require_admin_update policy, while checkout is SECURITY
--     INVOKER and normally runs as a CASHIER. An update-after-insert would work
--     for an owner testing it and fail in production for the role that actually
--     rings up sales. So the deduction now runs BEFORE the line insert.
--
--  2. The FIFO body moves into a new procedure that reports cost and shortfall
--     through INOUT parameters. The existing three-argument
--     process_inventory_deduction is KEPT, as a thin wrapper, because
--     db/tests/inventory_fifo_verification.sql calls it in five places and
--     other call sites should not have to care about cost. Its signature is
--     unchanged, so those assertions keep proving the FIFO behaviour is intact.
--
--  3. Deduction is coalesced per ingredient across the whole cart (0007), so
--     cost lands per INGREDIENT, not per line. Each line is then charged in
--     proportion to what it consumed: line_cost = ingredient_cost x
--     (line_requirement / total_requirement). Those shares sum back to exactly
--     the ingredient cost, so the order total is never over- or under-stated.
--
-- cost_is_complete is the honesty flag. It is false when any ingredient of the
-- line ran short (the sale drew stock that was never recorded, so part of it
-- has no cost) and false when the item has NO recipe at all. In both cases
-- cost_at_sale is 0 or a floor — reporting must not read it as "this sale was
-- pure profit".
--
-- Depends on: 0006/0007 (deduction + coalescing), 0012 (server-authoritative
-- pricing), 0013 (deficit upsert), 0010 (role policies)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The columns. Defaults make this backfill-safe: rows that predate the
--    migration keep cost_at_sale 0 and cost_is_complete FALSE, which is exactly
--    the truth about them — their cost was never captured and is not knowable
--    after the fact, since the lots they consumed are gone.
-- ----------------------------------------------------------------------------
ALTER TABLE public.order_items
    ADD COLUMN cost_at_sale     numeric NOT NULL DEFAULT 0,
    ADD COLUMN cost_is_complete boolean NOT NULL DEFAULT false;

ALTER TABLE public.order_items
    ADD CONSTRAINT order_items_cost_at_sale_check CHECK (cost_at_sale >= 0);

COMMENT ON COLUMN public.order_items.cost_at_sale IS
    'Actual cost of the inventory lots consumed by this line, captured at checkout (0015). A floor, not the truth, when cost_is_complete is false.';
COMMENT ON COLUMN public.order_items.cost_is_complete IS
    'TRUE only when every ingredient of this line was drawn in full from costed stock. FALSE when an ingredient ran short, or the item has no recipe — cost_at_sale is then understated.';

-- ----------------------------------------------------------------------------
-- 2. The FIFO body, now reporting what it consumed. This is the 0013 body with
--    two additions: it sums v_take * cost_at_purchase as it walks the lots, and
--    it reports any shortfall. The lock, the FIFO order, the deficit upsert and
--    the zero-quantity guard are unchanged.
--
--    SECURITY INVOKER (the default), like the procedure it replaces: a cashier's
--    sale must run under the cashier's own privileges so the 0010 policies apply.
-- ----------------------------------------------------------------------------
CREATE PROCEDURE app.process_inventory_deduction_costed(
    p_raw_item_id           uuid,
    p_organization_id       uuid,
    p_quantity_to_deduct    numeric,
    INOUT p_cost_consumed   numeric,
    INOUT p_quantity_short  numeric
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

        v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
        -- Sold beyond recorded supply: this part of the sale has no cost basis.
        p_quantity_short := v_remaining;

        -- Accumulate onto the item's running deficit total (0013), never a new row.
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

COMMENT ON PROCEDURE app.process_inventory_deduction_costed(uuid, uuid, numeric, numeric, numeric) IS
    'FIFO consumption of one raw ingredient, reporting the actual cost of the lots consumed and any shortfall (0015). SECURITY INVOKER: runs under the caller''s role so the 0010 policies apply.';

-- ----------------------------------------------------------------------------
-- 3. The original three-argument procedure is retained as a wrapper. Callers
--    that do not care about cost — including the FIFO assertion suite — keep
--    working against an unchanged signature, and there is still exactly ONE
--    implementation of the FIFO walk.
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
        p_raw_item_id, p_organization_id, p_quantity_to_deduct, v_cost, v_short);
END;
$$;

COMMENT ON PROCEDURE app.process_inventory_deduction(uuid, uuid, numeric) IS
    'FIFO consumption of one raw ingredient, recording any shortfall as a deficit. Thin wrapper over process_inventory_deduction_costed (0015) for callers that do not need the cost.';

-- ----------------------------------------------------------------------------
-- 4. Checkout — rebuilt from its CURRENT body (0012 pricing + 0007 coalescing),
--    with exactly two changes:
--      * the deduction loop moves ABOVE the order_items insert and collects the
--        actual cost per ingredient (see note 1 at the top: a cashier may not
--        UPDATE order_items, so cost must be known before the rows are written);
--      * the insert carries cost_at_sale and cost_is_complete.
--    Validation, server-authoritative pricing, the idempotency gate and the
--    deterministic lock order are untouched.
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
    -- raw_item_id -> { cost, short, qty } for this checkout.
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

    -- Every line must reference an item visible in THIS org. RLS on
    -- sellable_items scopes the join, so a foreign or non-existent item does
    -- not match and is counted as missing.
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

    -- Authoritative total: catalog price x quantity, summed server-side.
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

    -- Retry of an already-processed checkout: silent no-op, no re-deduction and
    -- therefore no double-counted cost.
    IF v_order_id IS NULL THEN
        RETURN;
    END IF;

    -- Coalesce (preserved from 0007): total raw requirement per ingredient
    -- across ALL cart lines, deducted once each, in deterministic lock order.
    -- Now also collecting what each deduction actually cost.
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
            v_ded.raw_item_id, v_org_id, v_ded.total_qty, v_cost, v_short);

        v_costs := v_costs || jsonb_build_object(
            v_ded.raw_item_id::text,
            jsonb_build_object('cost', v_cost, 'short', v_short, 'qty', v_ded.total_qty));
    END LOOP;

    -- Line items priced from the catalog, NOT from the payload, and costed from
    -- the stock this sale actually consumed.
    --
    -- The lateral charges each line its share of every ingredient it used. For
    -- an item with NO recipe the lateral is empty: SUM yields NULL -> 0 and
    -- BOOL_AND yields NULL -> false, so the line is recorded as uncosted rather
    -- than as costing nothing.
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

COMMENT ON PROCEDURE app.process_pos_checkout(jsonb) IS
    'Atomic POS checkout: idempotent per (organization, client_offline_id), priced server-side from the catalog (0012), deducting raw stock FIFO and recording the actual cost of goods sold on each line (0015).';

-- ----------------------------------------------------------------------------
-- 5. Privileges for the new procedure, mirroring the one it factors out of:
--    revoked from PUBLIC, executable by the application role.
-- ----------------------------------------------------------------------------
REVOKE ALL ON PROCEDURE
    app.process_inventory_deduction_costed(uuid, uuid, numeric, numeric, numeric) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON PROCEDURE
            app.process_inventory_deduction_costed(uuid, uuid, numeric, numeric, numeric)
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
