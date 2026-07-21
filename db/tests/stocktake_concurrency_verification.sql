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
-- 1. Shortfall on an item with NO recorded lots: expected 10, counted 8, and
--    nothing on the shelf to draw the missing 2 from. The books claimed stock
--    no lot holds, so the whole variance survives as a deficit (0019).
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

-- ----------------------------------------------------------------------------
-- 4. THE RECONCILIATION ITSELF (0019). An item that really has 1000g on the
--    shelf, counted at 800: posting must draw the lots down so the system
--    reports 800 — not leave 1000 standing with a 200 deficit beside it, which
--    is what it did before 0019 and which never corrected itself.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org     uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw     uuid := 'a5711000-0004-4004-8004-000000000004';
    v_st      uuid := '57000004-0004-4004-8004-000000000004';
    v_on_hand numeric;
    v_deficit numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_raw, v_org, 'Stock Count Rice', 'grams');

    -- Two lots at different prices; the cheaper expires first, so FIFO must
    -- take from it before touching the other.
    INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining,
         cost_at_purchase, expiry_date)
    VALUES (v_org, v_raw, 600, 600, 0.40, now() + interval '3 days'),
           (v_org, v_raw, 400, 400, 0.90, now() + interval '30 days');

    INSERT INTO public.stocktakes (id, organization_id, status) VALUES (v_st, v_org, 'draft');
    INSERT INTO public.stocktake_items
        (stocktake_id, organization_id, raw_item_id, expected_quantity, counted_quantity)
    VALUES (v_st, v_org, v_raw, 1000, 800);   -- variance = -200

    CALL app.post_stocktake(v_st);

    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_on_hand
    FROM public.inventory_batches WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_on_hand IS DISTINCT FROM 800 THEN
        RAISE EXCEPTION
            'the count must win: on-hand should be 800 after posting, got % (books still overstated)',
            v_on_hand;
    END IF;

    -- The shelf had enough to absorb the whole shortfall, so nothing is left
    -- "awaiting reconciliation".
    SELECT COALESCE(missing_quantity, 0) INTO v_deficit FROM public.inventory_deficits
    WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF COALESCE(v_deficit, 0) <> 0 THEN
        RAISE EXCEPTION
            'a shortfall absorbed by real lots must leave no deficit, got %', v_deficit;
    END IF;

    -- FIFO order: the 200 came out of the lot expiring soonest.
    SELECT quantity_remaining INTO v_on_hand FROM public.inventory_batches
    WHERE raw_item_id = v_raw AND cost_at_purchase = 0.40;
    IF v_on_hand IS DISTINCT FROM 400 THEN
        RAISE EXCEPTION 'the drawdown must follow FIFO: earliest-expiry lot should be 400, got %',
            v_on_hand;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A count settles an OUTSTANDING deficit. Sales that outran stock left a
--    deficit "awaiting reconciliation"; the count is that reconciliation, so
--    posting clears it rather than leaving the same discrepancy recorded twice.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org     uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw     uuid := 'a5711000-0005-4005-8005-000000000005';
    v_st      uuid := '57000005-0005-4005-8005-000000000005';
    v_rows    int;
    v_on_hand numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_raw, v_org, 'Stock Count Lentils', 'grams');
    INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
    VALUES (v_org, v_raw, 500, 500, 0.20);

    -- An earlier short sale left this behind.
    INSERT INTO public.inventory_deficits (organization_id, raw_item_id, missing_quantity)
    VALUES (v_org, v_raw, 75);

    -- The count agrees with the books exactly: variance 0.
    INSERT INTO public.stocktakes (id, organization_id, status) VALUES (v_st, v_org, 'draft');
    INSERT INTO public.stocktake_items
        (stocktake_id, organization_id, raw_item_id, expected_quantity, counted_quantity)
    VALUES (v_st, v_org, v_raw, 500, 500);

    CALL app.post_stocktake(v_st);

    SELECT count(*) INTO v_rows FROM public.inventory_deficits
    WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION
            'counting an item must settle its deficit, even at zero variance (% row(s) left)',
            v_rows;
    END IF;

    -- Clearing the deficit must not have disturbed the stock itself.
    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_on_hand
    FROM public.inventory_batches WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_on_hand IS DISTINCT FROM 500 THEN
        RAISE EXCEPTION 'a zero-variance count must leave stock untouched, got %', v_on_hand;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A shortfall LARGER than anything on the shelf: 300 counted as 0 when only
--    100 is recorded in lots. The lots empty, and only the 200 the books
--    claimed beyond them remains a deficit.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org     uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw     uuid := 'a5711000-0006-4006-8006-000000000006';
    v_st      uuid := '57000006-0006-4006-8006-000000000006';
    v_on_hand numeric;
    v_deficit numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_raw, v_org, 'Stock Count Herbs', 'grams');
    INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
    VALUES (v_org, v_raw, 100, 100, 0.10);

    INSERT INTO public.stocktakes (id, organization_id, status) VALUES (v_st, v_org, 'draft');
    INSERT INTO public.stocktake_items
        (stocktake_id, organization_id, raw_item_id, expected_quantity, counted_quantity)
    VALUES (v_st, v_org, v_raw, 300, 0);   -- variance = -300, but only 100 exists

    CALL app.post_stocktake(v_st);

    SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_on_hand
    FROM public.inventory_batches WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_on_hand <> 0 THEN
        RAISE EXCEPTION 'the lots must be emptied, got % left', v_on_hand;
    END IF;

    SELECT missing_quantity INTO v_deficit FROM public.inventory_deficits
    WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_deficit IS DISTINCT FROM 200 THEN
        RAISE EXCEPTION
            'only the 200 claimed beyond the lots should remain a deficit, got %', v_deficit;
    END IF;
END;
$$;

SELECT 'stocktake_concurrency_verification: all assertions passed' AS result;
