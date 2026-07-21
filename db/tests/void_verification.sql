-- ============================================================================
-- Order void verification (0018) — runs as mosaiz_app_user, switching between
-- the fixture's CASHIER and BRANCH MANAGER identities, because the whole point
-- of the void design is that those two roles get different answers.
--
-- Relies on the state cogs_verification leaves behind (its three orders and
-- their consumption rows), which makes the arithmetic here exact:
--   order -0001: 8 patties drawn as 5 @3.00 (cheap lot) + 3 @5.00 (dear lot)
--   order -0002: 7 patties drawn @5.00, 3 short (deficit), + a recipe-less item
--   order -0003: 6 cheese drawn @0.50 from the 100-unit lot (now 94)
--   stock now:  cheap patty lot 0, dear patty lot 0, cheese 94
--
-- Self-asserting; any broken expectation raises and fails CI.
-- Run order: immediately after cogs_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. A cashier MAY NOT void. The database refuses before any stock moves:
--    SELECT shows them the order, but the 0010 require_admin_update policy
--    filters their UPDATE, which the procedure reports as 42501.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    rejected  boolean := false;
    v_status  text;
    v_cheese  numeric;
    v_order   uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000003';

    BEGIN
        CALL app.void_order(v_order, true);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier voided an order';
    END IF;

    SELECT status INTO v_status FROM public.orders WHERE id = v_order;
    IF v_status <> 'completed' THEN
        RAISE EXCEPTION 'the refused void must leave the order completed, got %', v_status;
    END IF;

    SELECT sum(quantity_remaining) INTO v_cheese FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';
    IF v_cheese IS DISTINCT FROM 94.000 THEN
        RAISE EXCEPTION 'the refused void must not move stock (expected 94, got %)', v_cheese;
    END IF;

    -- And an order that does not exist is "not found", not "not permitted".
    rejected := false;
    BEGIN
        CALL app.void_order('00000000-0000-4000-8000-0000000000ff', true);
    EXCEPTION WHEN no_data_found THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'voiding a nonexistent order must raise no_data_found';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A manager voids the two-lot sale WITH restore: every unit goes back to the
--    exact lot it came from. The cheap lot was emptied by this sale alone, so it
--    must return to 5; the dear lot gave it 3, so it returns to 3 (its other 7
--    are still out with order -0002).
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_order    uuid;
    v_cheap    numeric;
    v_dear     numeric;
    v_restored boolean;
    v_by       uuid;
    v_ledger   int;
    v_cogs     numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000001';

    CALL app.void_order(v_order, true);

    SELECT stock_restored, voided_by INTO v_restored, v_by
    FROM public.orders WHERE id = v_order AND status = 'voided' AND voided_at IS NOT NULL;
    IF v_restored IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'void must record status, timestamp and the restore decision';
    END IF;
    IF v_by IS DISTINCT FROM 'c0570002-0000-4000-8000-000000000002'::uuid THEN
        RAISE EXCEPTION 'void must record who did it, got %', v_by;
    END IF;

    SELECT quantity_remaining INTO v_cheap FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 3.00;
    SELECT quantity_remaining INTO v_dear FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 5.00;

    IF v_cheap IS DISTINCT FROM 5.000 THEN
        RAISE EXCEPTION 'restore must refill the cheap lot to 5 (got %)', v_cheap;
    END IF;
    IF v_dear IS DISTINCT FROM 3.000 THEN
        RAISE EXCEPTION 'restore must return exactly 3 to the dear lot (got %)', v_dear;
    END IF;

    -- History is kept, not unwound: the ledger still says what was drawn, and
    -- the sale's recorded COGS is untouched.
    SELECT count(*) INTO v_ledger FROM public.inventory_consumption WHERE order_id = v_order;
    IF v_ledger <> 2 THEN
        RAISE EXCEPTION 'the consumption ledger must survive a void (expected 2 rows, got %)', v_ledger;
    END IF;
    SELECT cost_at_sale INTO v_cogs FROM public.order_items WHERE order_id = v_order;
    IF v_cogs IS DISTINCT FROM 30.00 THEN
        RAISE EXCEPTION 'a void must not rewrite the recorded COGS (got %)', v_cogs;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Re-voiding is refused — and, crucially, does not restore twice. A silent
--    no-op here would be tolerable; a second restore would invent 8 patties.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
    v_stock  numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000001';

    BEGIN
        CALL app.void_order(v_order, true);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a second void of the same order must be refused';
    END IF;

    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_stock IS DISTINCT FROM 8.000 THEN
        RAISE EXCEPTION 'DOUBLE RESTORE: patty stock should still be 8, got %', v_stock;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Voiding WITHOUT restore: the food was made, the ingredients are gone. The
--    money is corrected; the shelf is not touched.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order  uuid;
    v_cheese numeric;
    v_flag   boolean;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000003';

    CALL app.void_order(v_order, false);

    SELECT stock_restored INTO v_flag FROM public.orders
    WHERE id = v_order AND status = 'voided';
    IF v_flag IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'the no-restore decision must be recorded as false';
    END IF;

    SELECT sum(quantity_remaining) INTO v_cheese FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';
    IF v_cheese IS DISTINCT FROM 94.000 THEN
        RAISE EXCEPTION 'a no-restore void must leave stock deducted (expected 94, got %)', v_cheese;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Voiding the SHORT sale with restore: only the 7 units actually drawn come
--    back — the dear lot lands on exactly its received quantity, proving the
--    restore respects the lot's CHECK bound. The 3-unit deficit is deliberately
--    untouched: that stock never existed, so there is nothing to put back, and
--    the running total is stocktake's to reconcile.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order   uuid;
    v_dear    numeric;
    v_total   numeric;
    v_deficit numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000002';

    CALL app.void_order(v_order, true);

    SELECT quantity_remaining INTO v_dear FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 5.00;
    IF v_dear IS DISTINCT FROM 10.000 THEN
        RAISE EXCEPTION 'restore must return the 7 drawn units, filling the lot to 10 (got %)', v_dear;
    END IF;

    -- Conservation: with both patty sales restored, everything ever received is
    -- back on the shelf.
    SELECT sum(quantity_remaining) INTO v_total FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_total IS DISTINCT FROM 15.000 THEN
        RAISE EXCEPTION 'after restoring both sales, all 15 received units must be back (got %)', v_total;
    END IF;

    SELECT missing_quantity INTO v_deficit FROM public.inventory_deficits
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_deficit IS DISTINCT FROM 3.000 THEN
        RAISE EXCEPTION 'a void must not touch the deficit (expected 3, got %)', v_deficit;
    END IF;
END;
$$;

SELECT 'void_verification: all assertions passed' AS result;
