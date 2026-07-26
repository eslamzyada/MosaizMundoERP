-- ============================================================================
-- Migration 0029: An order you can still change
-- Mosaiz Mundo ERP
--
-- An order has been born finished. process_pos_checkout creates it, deducts
-- stock and marks it 'completed' in one statement, which is right for a counter
-- till and wrong for a restaurant: a table orders drinks, then starters, then
-- more bread, and pays at the end. There has been nowhere to put an order that
-- is still happening, so "edit the order in the queue" had nothing to edit.
--
-- This adds the missing state and the operations around it. The existing
-- one-step checkout is DELIBERATELY UNTOUCHED — quick service is a real
-- workflow, not a legacy path, and leaving it alone means this migration
-- cannot regress the till that already works.
--
-- ----------------------------------------------------------------------------
-- STOCK MOVES WHEN FOOD IS FIRED, NOT WHEN THE BILL IS PAID.
--
-- The ingredients leave the shelf when the kitchen cooks, so that is when the
-- deduction happens and when cost_at_sale is captured. Deducting at settle
-- would make stock lag reality by the length of a meal — the fridge would show
-- chicken that is already on a plate — and every "can I still sell this?"
-- answer during service would be wrong.
--
-- Revenue still recognises at SETTLE, because an open tab is not a sale. That
-- split (stock at fire, money at settle) is what real restaurant systems do,
-- and it falls out of the physical facts rather than being a convention.
--
-- Every existing revenue query already filters status = 'completed', so an open
-- order is invisible to them by construction — verified across the reports
-- before writing this, not assumed.
--
-- ----------------------------------------------------------------------------
-- WHY THESE ARE SECURITY DEFINER.
--
-- order_items carries require_admin_update and orders carries the equivalent
-- (0010), so a CASHIER cannot update either. That is deliberate and worth
-- keeping: it is what stops a till rewriting prices. But firing must stamp
-- fired_at and the captured cost onto a line, and settling must move the
-- order's status — both things a cashier legitimately does.
--
-- So these run as the definer, and the checks the RLS policies would have made
-- are made EXPLICITLY inside instead: the caller must belong to the order's
-- organization and must be sell-capable. Getting that wrong would expose every
-- tenant's orders, so the org check is written as the first thing each
-- procedure does, before it touches anything.
--
-- A caller from another organization gets "not found" rather than "forbidden",
-- so order ids cannot be probed across tenants.
--
-- Depends on: 0010 (role helpers), 0017 (costed deduction), 0028 (notes)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The state, and when each line was sent to the kitchen.
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE public.orders
    ADD CONSTRAINT orders_status_check
    CHECK (status IN ('open', 'completed', 'voided'));

ALTER TABLE public.order_items ADD COLUMN fired_at timestamptz;

COMMENT ON COLUMN public.order_items.fired_at IS
    'When this line was sent to the kitchen (0029). NULL means it is still being added to and no stock has moved for it. Stock is deducted and cost_at_sale captured at THIS moment, not at settle: the ingredients leave the shelf when the food is cooked.';

-- Finding the open tabs is the till''s most frequent question during service.
CREATE INDEX orders_open_idx
    ON public.orders (organization_id, created_at DESC)
    WHERE status = 'open';

-- ----------------------------------------------------------------------------
-- 2. Existing lines were all fired the moment their order was created — that is
--    what one-step checkout means — so they are backfilled before the guard
--    below is added. Without this the CHECK would reject every historical row:
--    they carry a real cost_at_sale but, until a moment ago, no fired_at.
-- ----------------------------------------------------------------------------
UPDATE public.order_items oi
SET fired_at = o.created_at
FROM public.orders o
WHERE o.id = oi.order_id AND oi.fired_at IS NULL;

-- One-step checkout must keep satisfying that guard, so it stamps fired_at too.
-- Derived mechanically from 0028 with exactly that one addition.
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
         cost_at_sale, cost_is_complete, note, fired_at)
    SELECT
        v_order_id,
        v_org_id,
        (item ->> 'sellable_item_id')::uuid,
        (item ->> 'quantity')::integer,
        s.price,
        COALESCE(c.line_cost, 0),
        COALESCE(c.complete, false),
        -- Same treatment as the order note, per line.
        NULLIF(btrim(item ->> 'note'), ''),
        -- A counter sale is fired the instant it is rung up: the kitchen is
        -- told and the stock has already moved by the time this row exists.
        now()
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
-- 3. Guard rails that the state change makes newly necessary.
--
--    An unfired line has no cost yet, so it must not claim to. Without this a
--    line could sit at cost_is_complete = true having consumed nothing, and the
--    margin report would count a dish nobody has cooked.
-- ----------------------------------------------------------------------------
ALTER TABLE public.order_items
    ADD CONSTRAINT order_items_unfired_has_no_cost
    CHECK (fired_at IS NOT NULL OR (cost_at_sale = 0 AND cost_is_complete = false));

-- ----------------------------------------------------------------------------
-- 4. The caller's right to touch this order, in one place.
--
--    SECURITY DEFINER means RLS does not filter anything below, so this IS the
--    tenant boundary. Returning the organization forces every caller to have
--    gone through it before it can name the org it is working in.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.assert_may_serve_order(p_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org uuid;
BEGIN
    SELECT organization_id INTO v_org FROM public.orders WHERE id = p_order_id;

    -- Not there, or not this caller's tenant: the same answer either way, so an
    -- order id cannot be probed across organizations.
    IF v_org IS NULL OR NOT app.user_belongs_to_org(v_org) THEN
        RAISE EXCEPTION 'order % not found in this organization', p_order_id
            USING ERRCODE = 'no_data_found';                       -- P0002
    END IF;

    IF NOT app.user_can_sell(v_org) THEN
        RAISE EXCEPTION 'serving an order is limited to sales roles'
            USING ERRCODE = 'insufficient_privilege';              -- 42501
    END IF;

    RETURN v_org;
END;
$$;

REVOKE ALL ON FUNCTION app.assert_may_serve_order(uuid) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 5. Keeping the order's total honest as its lines change.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.recalculate_order_total(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_total numeric;
BEGIN
    SELECT COALESCE(SUM(quantity * unit_price), 0) INTO v_total
    FROM public.order_items WHERE order_id = p_order_id;

    UPDATE public.orders SET total_amount = v_total WHERE id = p_order_id;
    RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION app.recalculate_order_total(uuid) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 6. Open a tab.
--
--    Prices are read from the catalogue exactly as checkout does (0012): the
--    client never states a price. Nothing is deducted and nothing is costed,
--    because nothing has been cooked.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.open_order(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org      uuid  := (payload ->> 'organization_id')::uuid;
    v_coid     uuid  := (payload ->> 'client_offline_id')::uuid;
    v_items    jsonb := payload -> 'items';
    v_note     text  := NULLIF(btrim(payload ->> 'note'), '');
    v_order_id uuid;
    v_missing  integer;
BEGIN
    IF v_org IS NULL OR v_coid IS NULL THEN
        RAISE EXCEPTION 'open_order requires organization_id and client_offline_id'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The tenant boundary, since DEFINER means RLS will not draw one.
    IF NOT app.user_belongs_to_org(v_org) THEN
        RAISE EXCEPTION 'organization % not found', v_org
            USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT app.user_can_sell(v_org) THEN
        RAISE EXCEPTION 'opening an order is limited to sales roles'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- An empty tab is legitimate: a table is seated before it orders.
    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array' THEN
        SELECT count(*) FILTER (WHERE s.id IS NULL) INTO v_missing
        FROM jsonb_array_elements(v_items) AS item
        LEFT JOIN public.sellable_items s
          ON s.id = (item ->> 'sellable_item_id')::uuid
         AND s.organization_id = v_org;
        IF v_missing > 0 THEN
            RAISE EXCEPTION 'order references % item(s) not on this menu', v_missing;
        END IF;
    END IF;

    INSERT INTO public.orders
        (organization_id, client_offline_id, status, total_amount, served_by, note)
    VALUES (v_org, v_coid, 'open', 0,
            NULLIF(current_setting('app.current_user_id', true), '')::uuid, v_note)
    -- Idempotent like checkout: a retried "open the tab" must not open a second.
    ON CONFLICT (organization_id, client_offline_id) DO NOTHING
    RETURNING id INTO v_order_id;

    IF v_order_id IS NULL THEN
        SELECT id INTO v_order_id FROM public.orders
        WHERE organization_id = v_org AND client_offline_id = v_coid;
        RETURN v_order_id;
    END IF;

    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array'
       AND jsonb_array_length(v_items) > 0 THEN
        PERFORM app.add_order_items(v_order_id, v_items);
    END IF;

    RETURN v_order_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Add lines to an open tab.
--
--    Lines land UNFIRED: adding a dish to the tab is not the same act as
--    sending it to be cooked, and conflating them would deduct stock for
--    something the kitchen has not been told about.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.add_order_items(p_order_id uuid, p_items jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org    uuid := app.assert_may_serve_order(p_order_id);
    v_status text;
    v_added  integer;
BEGIN
    SELECT status INTO v_status FROM public.orders WHERE id = p_order_id;
    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'order % is % and can no longer be added to', p_order_id, v_status
            USING ERRCODE = 'object_not_in_prerequisite_state';     -- 55000
    END IF;

    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
       OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'add_order_items requires a non-empty items array'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) AS item
        WHERE COALESCE((item ->> 'quantity')::integer, 0) <= 0
    ) THEN
        RAISE EXCEPTION 'every line must have a positive quantity';
    END IF;

    INSERT INTO public.order_items
        (order_id, organization_id, sellable_item_id, quantity, unit_price,
         cost_at_sale, cost_is_complete, note, fired_at)
    SELECT p_order_id,
           v_org,
           (item ->> 'sellable_item_id')::uuid,
           (item ->> 'quantity')::integer,
           -- Server-authoritative (0012): the till never states a price.
           s.price,
           0, false,
           NULLIF(btrim(item ->> 'note'), ''),
           NULL
    FROM jsonb_array_elements(p_items) AS item
    JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org;

    GET DIAGNOSTICS v_added = ROW_COUNT;
    IF v_added <> jsonb_array_length(p_items) THEN
        RAISE EXCEPTION 'order references item(s) not on this menu';
    END IF;

    PERFORM app.recalculate_order_total(p_order_id);
    RETURN v_added;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Remove a line that has NOT been cooked.
--
--    A fired line cannot be removed, because the food exists: the ingredients
--    are gone and somebody made it. Taking it off the bill is a different act
--    with different consequences, and that act is voiding — which asks whether
--    the food was made and what to do about the stock (0018). Allowing a quiet
--    delete here would destroy stock history and let a line vanish from a bill
--    without anyone answering for it.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.remove_order_item(p_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order  uuid;
    v_fired  timestamptz;
    v_status text;
BEGIN
    SELECT oi.order_id, oi.fired_at, o.status
      INTO v_order, v_fired, v_status
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.id = p_item_id;

    IF v_order IS NULL THEN
        RAISE EXCEPTION 'line % not found', p_item_id USING ERRCODE = 'no_data_found';
    END IF;

    PERFORM app.assert_may_serve_order(v_order);

    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'order is % and its lines can no longer be changed', v_status
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF v_fired IS NOT NULL THEN
        RAISE EXCEPTION
            'this line was sent to the kitchen at % and cannot simply be removed; '
            'void the order instead, which asks whether the food was made',
            v_fired
            USING ERRCODE = 'object_not_in_prerequisite_state';     -- 55000
    END IF;

    DELETE FROM public.order_items WHERE id = p_item_id;
    PERFORM app.recalculate_order_total(v_order);
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. Fire the unfired lines: the moment food starts being made.
--
--    This is where stock moves and cost is captured, and it mirrors checkout's
--    arithmetic exactly — ingredients coalesced across the lines being fired,
--    drawn in a deterministic order so a fire cannot deadlock against a
--    concurrent sale or stocktake, then the cost allocated back proportionally.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.fire_order(p_order_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org     uuid := app.assert_may_serve_order(p_order_id);
    v_status  text;
    v_pending integer;
    v_ded     record;
    v_costs   jsonb := '{}'::jsonb;
    v_cost    numeric;
    v_short   numeric;
BEGIN
    SELECT status INTO v_status FROM public.orders WHERE id = p_order_id;
    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'order % is % and cannot be fired', p_order_id, v_status
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT count(*) INTO v_pending
    FROM public.order_items WHERE order_id = p_order_id AND fired_at IS NULL;

    IF v_pending = 0 THEN
        -- Refusing rather than silently succeeding: a cashier pressing "send"
        -- twice should be told the kitchen already has it, not left wondering.
        RAISE EXCEPTION 'nothing on this order is waiting to be sent'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    FOR v_ded IN
        SELECT bom.raw_item_id,
               SUM(bom.quantity_required * oi.quantity) AS total_qty
        FROM public.order_items oi
        JOIN public.bill_of_materials bom
          ON bom.sellable_item_id = oi.sellable_item_id
         AND bom.organization_id  = oi.organization_id
        WHERE oi.order_id = p_order_id AND oi.fired_at IS NULL
        GROUP BY bom.raw_item_id
        ORDER BY bom.raw_item_id
    LOOP
        v_cost  := 0;
        v_short := 0;

        CALL app.process_inventory_deduction_costed(
            v_ded.raw_item_id, v_org, v_ded.total_qty, v_cost, v_short, p_order_id);

        v_costs := v_costs || jsonb_build_object(
            v_ded.raw_item_id::text,
            jsonb_build_object('cost', v_cost, 'short', v_short, 'qty', v_ded.total_qty));
    END LOOP;

    -- Correlated subqueries rather than a lateral join: the allocation is
    -- per line, and this keeps each line's share visibly tied to its own row.
    UPDATE public.order_items oi
    SET fired_at = now(),
        cost_at_sale = COALESCE((
            SELECT SUM(
                (v_costs -> bom.raw_item_id::text ->> 'cost')::numeric
                * (bom.quantity_required * oi.quantity)
                / NULLIF((v_costs -> bom.raw_item_id::text ->> 'qty')::numeric, 0))
            FROM public.bill_of_materials bom
            WHERE bom.sellable_item_id = oi.sellable_item_id
              AND bom.organization_id  = oi.organization_id), 0),
        -- BOOL_AND over no recipe lines is NULL, which coalesces to false:
        -- a dish with no recipe is uncosted, exactly as checkout treats it.
        cost_is_complete = COALESCE((
            SELECT BOOL_AND(
                COALESCE((v_costs -> bom.raw_item_id::text ->> 'short')::numeric, 0) = 0)
            FROM public.bill_of_materials bom
            WHERE bom.sellable_item_id = oi.sellable_item_id
              AND bom.organization_id  = oi.organization_id), false)
    WHERE oi.order_id = p_order_id AND oi.fired_at IS NULL;

    RETURN v_pending;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. Settle: the tab becomes a sale.
--
--    Refuses while anything is unfired. Those items were never cooked, so
--    settling would either charge for food that does not exist or silently drop
--    it from the bill — and the person standing at the till is the only one who
--    knows which was meant.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.settle_order(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_status  text;
    v_pending integer;
    v_total   numeric;
BEGIN
    PERFORM app.assert_may_serve_order(p_order_id);

    SELECT status INTO v_status FROM public.orders WHERE id = p_order_id;
    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'order % is % and cannot be settled', p_order_id, v_status
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT count(*) INTO v_pending
    FROM public.order_items WHERE order_id = p_order_id AND fired_at IS NULL;
    IF v_pending > 0 THEN
        RAISE EXCEPTION
            '% item(s) have not been sent to the kitchen; send or remove them '
            'before settling', v_pending
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = p_order_id) THEN
        RAISE EXCEPTION 'an empty order cannot be settled'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    v_total := app.recalculate_order_total(p_order_id);
    UPDATE public.orders SET status = 'completed' WHERE id = p_order_id;
    RETURN v_total;
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. Privileges, per convention.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'app.open_order(jsonb)',
        'app.add_order_items(uuid, jsonb)',
        'app.remove_order_item(uuid)',
        'app.fire_order(uuid)',
        'app.settle_order(uuid)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO mosaiz_app_user', fn);
        END IF;
    END LOOP;

    -- The two helpers are called from inside the procedures above, which run as
    -- the definer, so the app role needs no rights on them.
END;
$$;

COMMIT;
