-- ============================================================================
-- Inventory FIFO verification — runs as mosaiz_app_user (RLS applies).
-- Self-asserting: any broken expectation raises, psql exits non-zero, CI fails.
-- Run order: after pos_checkout_verification.sql (reuses the cccc... owner and
-- the ci-bistro-cairo org), before admin_checks.sql (which deletes cccc...).
--
-- 0006 note: inventory_batches now stocks RAW items, and
-- process_inventory_deduction is keyed by (raw_item_id, organization_id, qty)
-- and records a deficit row on shortfall.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

-- Fixed ids so assertions can target each lot directly.
--   raw item = f00d0001-...   batch A = ...000a   B = ...000b   C = ...000c

-- ----------------------------------------------------------------------------
-- 1. FIFO across two lots. Batch A expires SOONEST but was received LATEST;
--    Batch B expires later but was received earliest. Correct FIFO drains A
--    (by expiry) fully before touching B — proving expiry, not receipt order,
--    drives consumption.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw uuid := 'f00d0001-0001-4001-8001-000000000001';
    v_a   numeric;
    v_b   numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES (v_raw, v_org, 'Tomatoes', 'pieces');

    INSERT INTO public.inventory_batches
        (id, organization_id, raw_item_id, quantity_received,
         quantity_remaining, cost_at_purchase, expiry_date, received_at)
    VALUES
        ('ba7c0000-000a-4000-8000-00000000000a', v_org, v_raw, 10, 10, 2.00,
         now() + interval '1 day',  now() - interval '1 day'),   -- A: expires tomorrow
        ('ba7c0000-000b-4000-8000-00000000000b', v_org, v_raw, 10, 10, 2.00,
         now() + interval '7 days', now() - interval '10 days');  -- B: expires next week

    -- Deduct 15: A (10) fully, then 5 spills into B.
    CALL app.process_inventory_deduction(v_raw, v_org, 15);

    SELECT quantity_remaining INTO v_a
    FROM public.inventory_batches WHERE id = 'ba7c0000-000a-4000-8000-00000000000a';
    SELECT quantity_remaining INTO v_b
    FROM public.inventory_batches WHERE id = 'ba7c0000-000b-4000-8000-00000000000b';

    IF v_a <> 0 THEN
        RAISE EXCEPTION 'FIFO breach: Batch A (soonest expiry) must drain to 0, got %', v_a;
    END IF;
    IF v_b <> 5 THEN
        RAISE EXCEPTION 'FIFO breach: Batch B must hold exactly the 5-unit spillover, got %', v_b;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. NULLS LAST. Add Batch C with NULL expiry, received earliest of all.
--    A dated lot (B, 5 remaining) must be consumed before the undated C,
--    even though C was received far earlier.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw uuid := 'f00d0001-0001-4001-8001-000000000001';
    v_b   numeric;
    v_c   numeric;
BEGIN
    INSERT INTO public.inventory_batches
        (id, organization_id, raw_item_id, quantity_received,
         quantity_remaining, cost_at_purchase, expiry_date, received_at)
    VALUES
        ('ba7c0000-000c-4000-8000-00000000000c', v_org, v_raw, 10, 10, 2.00,
         NULL, now() - interval '30 days');   -- C: no expiry, received earliest

    -- Deduct 6: B still has 5 (dated) -> drained first, then 1 spills into C.
    CALL app.process_inventory_deduction(v_raw, v_org, 6);

    SELECT quantity_remaining INTO v_b
    FROM public.inventory_batches WHERE id = 'ba7c0000-000b-4000-8000-00000000000b';
    SELECT quantity_remaining INTO v_c
    FROM public.inventory_batches WHERE id = 'ba7c0000-000c-4000-8000-00000000000c';

    IF v_b <> 0 THEN
        RAISE EXCEPTION 'NULLS LAST breach: dated Batch B must drain before undated C, B got %', v_b;
    END IF;
    IF v_c <> 9 THEN
        RAISE EXCEPTION 'NULLS LAST breach: undated Batch C should lose only the 1-unit spillover, got %', v_c;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Deficit rule. Only 9 units remain (all in C). Deducting 100 must drain
--    everything to 0, record a persistent deficit of 91, and NOT raise — a
--    raised exception here would roll back a real checkout (docs/pos_offline.md §3).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org      uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw      uuid := 'f00d0001-0001-4001-8001-000000000001';
    v_c        numeric;
    v_deficit  numeric;
    v_crashed  boolean := false;
BEGIN
    BEGIN
        CALL app.process_inventory_deduction(v_raw, v_org, 100);
    EXCEPTION WHEN OTHERS THEN
        v_crashed := true;   -- a recorded deficit does NOT reach here; only a real error would
    END;

    IF v_crashed THEN
        RAISE EXCEPTION 'deficit rule violated: over-deduction must not raise/roll back the sale';
    END IF;

    SELECT quantity_remaining INTO v_c
    FROM public.inventory_batches WHERE id = 'ba7c0000-000c-4000-8000-00000000000c';
    IF v_c <> 0 THEN
        RAISE EXCEPTION 'deficit: all available stock should be drained to 0, Batch C got %', v_c;
    END IF;

    SELECT missing_quantity INTO v_deficit
    FROM public.inventory_deficits
    WHERE raw_item_id = v_raw AND organization_id = v_org;
    IF v_deficit IS DISTINCT FROM 91 THEN
        RAISE EXCEPTION 'deficit ledger: expected a recorded shortfall of 91, got %', v_deficit;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Non-positive deduction is a caller bug, and must be rejected outright.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org     uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw     uuid := 'f00d0001-0001-4001-8001-000000000001';
    rejected  boolean := false;
BEGIN
    BEGIN
        CALL app.process_inventory_deduction(v_raw, v_org, 0);
    EXCEPTION WHEN raise_exception THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a zero/negative deduction must be rejected';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Reorder threshold (0009). Defaults to 0 (alert disabled) for rows created
--    before/without it, accepts a positive minimum, and — proving the INSERT
--    path itself is open to the app role, so the negative_checks rejection of a
--    negative threshold can only be the CHECK — accepts an explicit 0.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org       uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw       uuid := 'f00d0001-0001-4001-8001-000000000001';
    v_default   numeric;
    v_updated   numeric;
    v_explicit  numeric;
BEGIN
    -- The Tomatoes row from section 1 was inserted without the column.
    SELECT reorder_threshold INTO v_default
    FROM public.raw_inventory_items WHERE id = v_raw;
    IF v_default IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'reorder_threshold must backfill to 0, got %', v_default;
    END IF;

    UPDATE public.raw_inventory_items
    SET reorder_threshold = 25.500
    WHERE id = v_raw;

    SELECT reorder_threshold INTO v_updated
    FROM public.raw_inventory_items WHERE id = v_raw;
    IF v_updated IS DISTINCT FROM 25.500 THEN
        RAISE EXCEPTION 'reorder_threshold must accept a positive minimum, got %', v_updated;
    END IF;

    INSERT INTO public.raw_inventory_items
        (id, organization_id, name, unit_of_measure, reorder_threshold)
    VALUES ('f00d0002-0002-4002-8002-000000000002', v_org, 'Salt', 'grams', 0);

    SELECT reorder_threshold INTO v_explicit
    FROM public.raw_inventory_items WHERE id = 'f00d0002-0002-4002-8002-000000000002';
    IF v_explicit IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'an explicit zero threshold must be accepted, got %', v_explicit;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Deficit running total (0013). Section 3 left f00d0001 with a deficit of 91
--    (and zero stock). A further shortfall must ACCUMULATE onto that total in a
--    SINGLE row, not create a second row — the fix for unbounded ledger growth.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_org      uuid := (SELECT id FROM public.organizations WHERE slug = 'ci-bistro-cairo');
    v_raw      uuid := 'f00d0001-0001-4001-8001-000000000001';
    v_rows     integer;
    v_deficit  numeric;
BEGIN
    -- Still zero stock, so all 9 become deficit; upserts onto the running 91.
    CALL app.process_inventory_deduction(v_raw, v_org, 9);

    SELECT count(*), max(missing_quantity)
      INTO v_rows, v_deficit
    FROM public.inventory_deficits
    WHERE raw_item_id = v_raw AND organization_id = v_org;

    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'deficit rollup: expected exactly 1 row per item, got % (not accumulated?)', v_rows;
    END IF;
    IF v_deficit IS DISTINCT FROM 100 THEN
        RAISE EXCEPTION 'deficit rollup: 91 + 9 must accumulate to 100, got %', v_deficit;
    END IF;

    -- And a direct duplicate INSERT is now rejected by the unique constraint.
    BEGIN
        INSERT INTO public.inventory_deficits (organization_id, raw_item_id, missing_quantity)
        VALUES (v_org, v_raw, 1);
        RAISE EXCEPTION 'a second deficit row per (org, item) must be rejected';
    EXCEPTION WHEN unique_violation THEN
        NULL;  -- expected
    END;
END;
$$;

SELECT 'inventory_fifo_verification: all assertions passed' AS result;
