-- ============================================================================
-- Migration 0026: Record who rang up each sale
-- Mosaiz Mundo ERP
--
-- orders has recorded voided_by since 0018 — who CANCELLED a sale — and has
-- never recorded who MADE one. So the system knows exactly who reversed money
-- and nothing about who took it, which is the wrong way round: voids are rare
-- and sales are the job.
--
-- Nothing about employee performance can be computed without this. Not sales
-- per person, not average order value, not a void rate, because a rate needs
-- both a numerator and the denominator of what that person actually served.
--
-- WHY NULLABLE, AND WHY NOT BACKFILLED. Every order already in the database was
-- placed before this column existed, and the information about who served them
-- is not somewhere else waiting to be copied — it was never captured. A NOT
-- NULL column would make the migration unappliable; a backfill would have to
-- invent an answer. Attributing historical sales to whoever happens to be the
-- org's owner, or spreading them evenly, would produce a performance report
-- that looks complete and is fiction. NULL means "nobody recorded this", which
-- is true, and the report says so out loud rather than quietly excluding them.
--
-- WHERE THE IDENTITY COMES FROM. process_pos_checkout is SECURITY INVOKER, so
-- it runs as the cashier, and app.current_user_id is the identity the auth
-- middleware bound for this request. No new parameter is needed and none is
-- offered: a client-supplied "served_by" could name anyone, and an attribution
-- the till can choose is not attribution at all.
--
-- ON THE IDEMPOTENT RETRY. The INSERT is ON CONFLICT DO NOTHING (0004), so a
-- replayed client_offline_id does not re-stamp the order. That matters offline:
-- a queued sale synced later by a different device must keep the cashier who
-- actually served it, not whoever pressed sync.
--
-- Depends on: 0004 (orders, checkout), 0017 (the current checkout body)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The column.
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN served_by uuid REFERENCES public.users (id);

COMMENT ON COLUMN public.orders.served_by IS
    'Who rang this sale up, from app.current_user_id at checkout (0026). NULL for orders placed before this column existed — that is genuinely unknown, never inferred. Contrast voided_by, which records who cancelled.';

-- "How did this employee do over this period" scans by person and time.
-- Partial: an unattributed order has nothing to report on, and excluding the
-- historical rows keeps the index proportional to the data it can answer for.
CREATE INDEX orders_served_by_idx
    ON public.orders (organization_id, served_by, created_at DESC)
    WHERE served_by IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Checkout stamps it.
--
--    This is the 0017 body verbatim, with two changes: the caller is resolved
--    into v_served_by, and the orders INSERT carries it. Pricing, validation,
--    the idempotency gate, coalesced deduction, the deterministic lock order,
--    cost capture and the consumption ledger are all untouched.
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

    INSERT INTO public.orders (organization_id, client_offline_id, total_amount, served_by)
    VALUES (v_org_id, v_coid, v_total, v_served_by)
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
COMMIT;
