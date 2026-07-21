-- ============================================================================
-- Migration 0018: Void an order, with an explicit choice about the stock
-- Mosaiz Mundo ERP
--
-- orders.status has allowed 'voided' since 0004, reporting has excluded voided
-- orders since it existed — and nothing in the system could actually void one.
-- A cashier who rang up the wrong thing had no correction path short of a
-- manual UPDATE as the superuser.
--
-- The hard question is not the status flip; it is what a void means for the
-- ingredients the sale drew down. Two opposite things get called "voiding":
--
--   * The mis-tap: wrong item, caught before the kitchen moved. The food was
--     never made, the ingredients never left the shelf — the deduction must be
--     reversed or the system understates stock it still has.
--   * The remake / walk-out: the food WAS made. The ingredients are gone
--     regardless of the refund — restoring them would invent stock, and the
--     error compounds until a stocktake catches it.
--
-- Only the person voiding knows which happened, so the procedure takes the
-- answer as a parameter (p_restore_stock) instead of guessing. Any fixed rule
-- is wrong half the time.
--
-- RESTORE GOES BACK TO THE ORIGINAL LOTS, not to a new adjustment lot. The
-- consumption ledger (0017) records exactly which lot each unit came from, so
-- the reversal is exact — and, critically, the stock re-acquires its original
-- expiry date and cost. A fresh adjustment lot would carry no expiry: returned
-- stock from a lot expiring tomorrow would masquerade as non-perishable, which
-- is a food-safety hazard, not a bookkeeping nicety. The batches CHECK
-- (quantity_remaining <= quantity_received) bounds the return: nothing else
-- ever increases a lot's remaining, and re-voiding is blocked below, so the
-- restore can never overfill a lot.
--
-- DEFICITS ARE DELIBERATELY UNTOUCHED. A short sale recorded its unmet part in
-- inventory_deficits, not in the consumption ledger — that stock never existed,
-- so there is nothing to put back, and the running total is not attributable
-- per order (0013 collapsed it by design). Voiding restores only what was
-- actually drawn; the deficit remains a reconciliation figure for stocktake.
--
-- The consumption rows themselves are KEPT. They are the record of what
-- happened, and what happened includes both the sale and its reversal;
-- deleting them would also erase lot traceability for the period the stock
-- was out of the fridge.
--
-- Authorization: SECURITY INVOKER, like checkout. The procedure's first write
-- is the status UPDATE on orders, which the 0010 require_admin_update
-- RESTRICTIVE policy limits to owner / regional_manager / branch_manager — so
-- the database itself refuses a cashier's void before any stock moves. The
-- API's requireRole is the courtesy 403 in front of that.
--
-- Error contract (for the API to map cleanly):
--   P0002  order does not exist / not visible in this organization  -> 404
--   55000  order is already voided                                  -> 409
--   42501  caller may see the order but may not void it             -> 403
--
-- Depends on: 0010 (require_admin_update), 0015 (cost capture), 0017 (ledger)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Void metadata. Nullable: null on every non-voided order, and on any row
--    voided outside this procedure (none exist today, but the columns make no
--    claim the data cannot keep).
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN voided_at      timestamptz,
    ADD COLUMN voided_by      uuid REFERENCES public.users (id),
    ADD COLUMN stock_restored boolean;

COMMENT ON COLUMN public.orders.stock_restored IS
    'For a voided order: whether the void returned the consumed stock to its lots (food never made) or left it deducted (food was made/wasted). NULL for non-voided orders. The choice is made by the person voiding (0018).';

-- ----------------------------------------------------------------------------
-- 2. The procedure.
-- ----------------------------------------------------------------------------
CREATE PROCEDURE app.void_order(
    p_order_id      uuid,
    p_restore_stock boolean
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_status  text;
    v_org     uuid;
    v_updated integer;
    v_item    record;
BEGIN
    IF p_order_id IS NULL OR p_restore_stock IS NULL THEN
        RAISE EXCEPTION 'void_order requires an order id and an explicit stock decision';
    END IF;

    -- SELECT is ungated, so any member of the org can see the order. The read
    -- also tells apart "not there" from "already voided" for the error contract.
    SELECT status, organization_id INTO v_status, v_org
    FROM public.orders WHERE id = p_order_id;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'order % not found in this organization', p_order_id
            USING ERRCODE = 'no_data_found';                       -- P0002
    END IF;
    IF v_status = 'voided' THEN
        -- Refusing (rather than a silent no-op) matters: a retry could carry a
        -- DIFFERENT restore decision, and a repeat restore would double stock.
        RAISE EXCEPTION 'order % is already voided', p_order_id
            USING ERRCODE = 'object_not_in_prerequisite_state';    -- 55000
    END IF;

    -- The write the 0010 policy gates. For a non-admin the RESTRICTIVE policy
    -- filters the row and this updates nothing — which, given the row provably
    -- exists and is completed, can only mean the caller lacks the role.
    UPDATE public.orders
    SET status         = 'voided',
        voided_at      = now(),
        voided_by      = NULLIF(current_setting('app.current_user_id', true), '')::uuid,
        stock_restored = p_restore_stock
    WHERE id = p_order_id AND status = 'completed';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
        RAISE EXCEPTION 'voiding an order is limited to managers'
            USING ERRCODE = 'insufficient_privilege';              -- 42501
    END IF;

    IF NOT p_restore_stock THEN
        RETURN;
    END IF;

    -- Put every consumed unit back into the lot it came from. Locks are taken
    -- per ingredient in the same deterministic order checkout uses, so a void
    -- cannot deadlock against a concurrent sale or stocktake on the same items.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || raw_item_id::text))
    FROM (
        SELECT DISTINCT raw_item_id
        FROM public.inventory_consumption
        WHERE order_id = p_order_id
        ORDER BY raw_item_id
    ) locked;

    FOR v_item IN
        SELECT batch_id, SUM(quantity) AS quantity
        FROM public.inventory_consumption
        WHERE order_id = p_order_id
        GROUP BY batch_id
    LOOP
        UPDATE public.inventory_batches
        SET quantity_remaining = quantity_remaining + v_item.quantity
        WHERE id = v_item.batch_id;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE app.void_order(uuid, boolean) IS
    'Voids a completed order. p_restore_stock: true returns each consumed quantity to its original lot (exact reversal via the 0017 ledger, preserving expiry and cost); false leaves stock deducted (food was made). Admin-only via the 0010 orders UPDATE policy; SECURITY INVOKER.';

-- ----------------------------------------------------------------------------
-- 3. Privileges, per convention.
-- ----------------------------------------------------------------------------
REVOKE ALL ON PROCEDURE app.void_order(uuid, boolean) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON PROCEDURE app.void_order(uuid, boolean) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
