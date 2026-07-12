-- ============================================================================
-- Stocktake reconciliation & concurrency verification
--   — runs as mosaiz_app_user (RLS applies).
-- Self-asserting; any broken expectation raises and fails CI.
-- Run order: after bom_integration_verification.sql, before admin_checks.sql.
-- ============================================================================
--
-- ON THE ADVISORY LOCK (why this is concurrency-safe, though not simulated here)
-- ---------------------------------------------------------------------------
-- A single sequential psql script runs in ONE connection, so it cannot exhibit
-- a true race. The safety guarantee instead comes from the lock KEY that
-- post_stocktake and process_inventory_deduction share:
--
--     pg_advisory_xact_lock(hashtext('inventory_' || raw_item_id::text))
--
-- Both procedures compute the identical key for a given raw item, and both take
-- it as a TRANSACTION-level lock (auto-released only at COMMIT/ROLLBACK):
--
--   * post_stocktake acquires it up front for every counted item, then updates
--     status and writes the deficit/true-up rows — all while holding the lock.
--   * process_inventory_deduction acquires the SAME key before it reads or
--     writes inventory_batches.
--
-- So if terminal A is mid-post for "Beef Patty" and terminal B rings up a
-- burger at the same instant, B's deduction blocks on the advisory lock until
-- A commits. B then proceeds against the already-reconciled batch balances —
-- no lost update, no double counting between the manual count and live sales.
-- Acquiring locks in raw_item_id order (in both procedures) means two
-- concurrent posters/checkouts take shared keys in the same order, so they
-- cannot deadlock.
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP on

SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

-- ----------------------------------------------------------------------------
-- 1. Required scenario: expected 10, counted 8 -> post -> deficit of 2 logged.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw uuid := 'a5711000-0001-4001-8001-000000000001';
    v_st  uuid := '57000001-0001-4001-8001-000000000001';
    v_status  text;
    v_deficit numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_raw, v_org, 'Stock Count Flour', 'grams');

    INSERT INTO public.stocktakes (id, organization_id, status)
    VALUES (v_st, v_org, 'draft');

    INSERT INTO public.stocktake_items
        (stocktake_id, organization_id, raw_item_id, expected_quantity, counted_quantity)
    VALUES (v_st, v_org, v_raw, 10, 8);   -- variance = -2 (generated)

    CALL app.post_stocktake(v_st);

    SELECT status INTO v_status FROM public.stocktakes WHERE id = v_st;
    IF v_status <> 'posted' THEN
        RAISE EXCEPTION 'post_stocktake should mark the stocktake posted, got %', v_status;
    END IF;

    SELECT missing_quantity INTO v_deficit
    FROM public.inventory_deficits
    WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_deficit IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'reconciliation: expected a logged deficit of 2, got %', v_deficit;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Positive variance: expected 5, counted 8 -> post -> a +3 true-up lot is
--    added to inventory_batches (found stock, cost 0).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw uuid := 'a5711000-0002-4002-8002-000000000002';
    v_st  uuid := '57000002-0002-4002-8002-000000000002';
    v_found numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_raw, v_org, 'Stock Count Sugar', 'grams');

    INSERT INTO public.stocktakes (id, organization_id, status)
    VALUES (v_st, v_org, 'draft');

    INSERT INTO public.stocktake_items
        (stocktake_id, organization_id, raw_item_id, expected_quantity, counted_quantity)
    VALUES (v_st, v_org, v_raw, 5, 8);    -- variance = +3

    CALL app.post_stocktake(v_st);

    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_found
    FROM public.inventory_batches
    WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_found <> 3 THEN
        RAISE EXCEPTION 'reconciliation: surplus should add a 3-unit true-up lot, got %', v_found;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Status guard: a stocktake already posted cannot be posted again.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_st uuid := '57000001-0001-4001-8001-000000000001';   -- posted in scenario 1
    rejected boolean := false;
BEGIN
    BEGIN
        CALL app.post_stocktake(v_st);
    EXCEPTION WHEN raise_exception THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 're-posting a posted stocktake must be rejected';
    END IF;
END;
$$;

SELECT 'stocktake_concurrency_verification: all assertions passed' AS result;
