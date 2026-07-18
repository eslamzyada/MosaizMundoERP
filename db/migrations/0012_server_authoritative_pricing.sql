-- ============================================================================
-- Migration 0012: Server-authoritative checkout pricing (fixes F-01, Critical)
-- Mosaiz Mundo ERP
--
-- Until now app.process_pos_checkout stored orders.total_amount and every
-- order_items.unit_price STRAIGHT FROM THE CLIENT PAYLOAD, and never consulted
-- sellable_items.price. Demonstrated: a cashier sold a 75.00 item for a stored
-- unit_price of 0.01. Any legitimate cashier token — or a tampered POS build —
-- could under-ring sales at will. The CHECK constraints only block negatives,
-- not underpricing.
--
-- This makes the DATABASE the price authority:
--   * Each line's unit_price is looked up from sellable_items.price (RLS-scoped
--     to the caller's org). The payload's unit_price is ignored entirely.
--   * total_amount is recomputed as SUM(price x quantity). The payload's
--     total_amount is ignored entirely.
--   * A line referencing an item not visible in the caller's org is a hard
--     error, not a silent skip.
--   * Quantity must be positive (order_items already CHECKs this; we reject
--     early so the whole checkout fails fast with a readable error).
--
-- Everything else is preserved EXACTLY from the current (0007) definition:
-- idempotency via ON CONFLICT (organization_id, client_offline_id), and the
-- COALESCED BOM-resolved FIFO deduction (one deduction per raw ingredient,
-- summed across all cart lines, in deterministic lock order). Signature is
-- unchanged, so CREATE OR REPLACE keeps the EXECUTE grant. The POS still sends
-- unit_price/total_amount; they are simply no longer trusted, so no client
-- change is required.
--
-- Depends on: 0007 (current process_pos_checkout + coalescing), 0008 (price)
-- ============================================================================

BEGIN;

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

    -- Retry of an already-processed checkout: silent no-op, no re-deduction.
    IF v_order_id IS NULL THEN
        RETURN;
    END IF;

    -- Line items priced from the catalog, NOT from the payload.
    INSERT INTO public.order_items
        (order_id, organization_id, sellable_item_id, quantity, unit_price)
    SELECT
        v_order_id,
        v_org_id,
        (item ->> 'sellable_item_id')::uuid,
        (item ->> 'quantity')::integer,
        s.price
    FROM jsonb_array_elements(v_items) AS item
    JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org_id;

    -- Coalesce (preserved from 0007): total raw requirement per ingredient
    -- across ALL cart lines, deducted once each, in deterministic lock order.
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
    'Idempotent POS checkout. Server-authoritative pricing (0012): unit_price and '
    'total_amount come from sellable_items.price, never the payload. Coalesced '
    'BOM-resolved FIFO deduction (0007). Retrying the same (organization_id, '
    'client_offline_id) is a silent no-op. SECURITY INVOKER — RLS validates the org.';

COMMIT;
