-- ============================================================================
-- Migration 0028: What the customer actually asked for
-- Mosaiz Mundo ERP
--
-- An order records what was sold and nothing about how it was wanted. "Burger
-- x2" cannot say "no onions", and the order as a whole cannot say "table 5" or
-- "nut allergy". Today that information travels by shouting across a kitchen,
-- which is exactly the sort of thing that stops working on a busy Friday.
--
-- TWO LEVELS, because they are different facts.
--
--   order_items.note  belongs to ONE LINE: "no onions", "well done", "extra
--                     hot". It is what the cook needs while making that dish,
--                     and it must print on the ticket beside its own item.
--
--   orders.note       belongs to the WHOLE ORDER: "table 5", "takeaway",
--                     "allergy — nuts", "customer waiting". It is context for
--                     the order, not an instruction about any single dish.
--
-- Collapsing them into one field would force a cook to read the whole order's
-- text to find out whether THIS burger has onions, which is how allergy
-- information gets missed.
--
-- SAME ITEM, DIFFERENT NOTES, STAYS TWO LINES. Two burgers where one has no
-- onions are genuinely two different things to cook, and the till already
-- creates one order_items row per cart line. Nothing here coalesces them, and
-- nothing should.
--
-- The notes are TRIMMED and BOUNDED in the database rather than in the client:
-- an untrimmed "   " is not a note, and a note nobody bounded is a field
-- somebody eventually pastes a receipt into. The line limit is deliberately
-- short — a line note is an instruction, and one that does not fit on a
-- kitchen ticket is not one.
--
-- Notes are recorded by whoever takes the order, so they ride in on the
-- existing checkout payload and are written by the same SECURITY INVOKER
-- procedure a cashier already runs. No new privilege is involved.
--
-- Depends on: 0026 (the current process_pos_checkout, reproduced below)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The columns.
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN note text
        CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 500));

ALTER TABLE public.order_items
    ADD COLUMN note text
        CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 200));

COMMENT ON COLUMN public.orders.note IS
    'Context for the whole order (0028): table number, takeaway, an allergy warning. NOT instructions for a single dish — those live on order_items.note, so a cook does not have to read the order to find out about one item.';
COMMENT ON COLUMN public.order_items.note IS
    'How this one line is wanted (0028): "no onions", "well done". Prints beside its own item on the kitchen ticket. Deliberately short: an instruction that does not fit on a ticket is not one.';

-- ----------------------------------------------------------------------------
-- 2. Checkout carries them.
--
--    This is 0026's procedure — the current one, which attributes the sale —
--    with three additions and nothing else changed: the order-level note, the
--    line-level note, and the trimming of both. It was derived mechanically
--    from 0026 rather than retyped, because hand-copying a 90-line procedure is
--    how an earlier migration's work silently disappears.
--    Validation, pricing, the idempotency gate, ingredient coalescing, the
--    deterministic lock order and the cost allocation are all untouched.
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
    -- The caller, resolved once. SECURITY INVOKER means this procedure runs
    -- as the cashier who actually rang the sale up, so the session variable
    -- the auth middleware bound IS the person standing at the till.
    v_served_by uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    -- Blank is not a note: normalising here means the CHECK sees NULL rather
    -- than '   ', and a client sending an empty string is not punished for it.
    v_note      text := NULLIF(btrim(payload ->> 'note'), '');
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

    INSERT INTO public.orders
        (organization_id, client_offline_id, total_amount, served_by, note)
    VALUES (v_org_id, v_coid, v_total, v_served_by, v_note)
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
         cost_at_sale, cost_is_complete, note)
    SELECT
        v_order_id,
        v_org_id,
        (item ->> 'sellable_item_id')::uuid,
        (item ->> 'quantity')::integer,
        s.price,
        COALESCE(c.line_cost, 0),
        COALESCE(c.complete, false),
        -- Same treatment as the order note, per line.
        NULLIF(btrim(item ->> 'note'), '')
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
    'Idempotent POS checkout: validates the cart, prices it server-authoritatively, deducts stock FIFO capturing cost at sale, attributes the sale to the caller, and records the order-level and per-line notes (0028). SECURITY INVOKER, so RLS and the 0010 role policies apply to the cashier running it.';

COMMIT;
