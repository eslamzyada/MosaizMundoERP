-- ============================================================================
-- Cost precision and lot bill verification (0025) — runs as mosaiz_app_user
-- under the cogs fixture's BRANCH MANAGER identity.
--
-- The bug this pins down was silent and systematic: cost_at_purchase was
-- numeric(10,2), so a per-gram rate — a fraction of a piastre — was rounded to
-- two decimals before anything else touched it. A 250.00 delivery of 8000 g
-- stored 0.03/g and reported 240.00. Not a display glitch: that rounded rate is
-- what FIFO multiplies to produce cost of goods sold, so it reached margin,
-- waste cost and stock value.
--
-- Run order: immediately after ingredient_lifecycle_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

-- ----------------------------------------------------------------------------
-- 1. A gram-priced delivery reconciles to its invoice, to the piastre.
--
--    This is the exact case from the report: 250.00 for 8000 g. Under the old
--    numeric(10,2) rate it valued at 240.00 and the missing 10.00 was
--    unrecoverable.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_item  uuid;
    v_lot   uuid;
    v_rate  numeric;
    v_value numeric;
    v_bill  numeric;
BEGIN
    INSERT INTO public.raw_inventory_items (organization_id, name, unit_of_measure)
    VALUES ('c0570000-0000-4000-8000-000000000000', 'Precision Rice', 'جرام')
    RETURNING id INTO v_item;

    INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining,
         cost_at_purchase, total_cost)
    VALUES ('c0570000-0000-4000-8000-000000000000', v_item, 8000, 8000,
            250.00 / 8000, 250.00)
    RETURNING id INTO v_lot;

    SELECT cost_at_purchase, total_cost INTO v_rate, v_bill
    FROM public.inventory_batches WHERE id = v_lot;

    IF v_rate IS DISTINCT FROM 0.031250 THEN
        RAISE EXCEPTION 'the per-gram rate must survive as 0.031250, got % '
            '(a 2-decimal column would have made this 0.03)', v_rate;
    END IF;
    IF v_bill IS DISTINCT FROM 250.00 THEN
        RAISE EXCEPTION 'the invoice figure must be recorded, got %', v_bill;
    END IF;

    SELECT quantity_remaining * cost_at_purchase INTO v_value
    FROM public.inventory_batches WHERE id = v_lot;
    IF v_value IS DISTINCT FROM 250.000000 THEN
        RAISE EXCEPTION 'stock value must reconcile to the invoice exactly '
            '(expected 250.00, got %)', v_value;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. The rate survives being CONSUMED. inventory_consumption copies it, and a
--    2-decimal copy there would have thrown the precision away one step later —
--    which is the whole reason all three rate columns were widened together.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_item  uuid;
    v_cost  numeric := 0;
    v_short numeric := 0;
    v_rate  numeric;
    v_rows  int;
BEGIN
    SELECT id INTO v_item FROM public.raw_inventory_items
    WHERE name = 'Precision Rice'
      AND organization_id = 'c0570000-0000-4000-8000-000000000000';

    -- 1000 g at 0.031250 = 31.25 exactly. At the old rate it was 30.00.
    CALL app.process_inventory_deduction_costed(
        v_item, 'c0570000-0000-4000-8000-000000000000', 1000, v_cost, v_short, NULL);

    IF v_cost IS DISTINCT FROM 31.250000 THEN
        RAISE EXCEPTION 'consuming 1000 g must cost 31.25, got % '
            '(30.00 means the rate was rounded)', v_cost;
    END IF;
    IF v_short <> 0 THEN
        RAISE EXCEPTION 'there was plenty of stock; nothing should be short';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A write-off copies the same undamaged rate, so waste cost is right too.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_item uuid;
    v_id   uuid;
    v_cost numeric;
    v_rate numeric;
BEGIN
    SELECT id INTO v_item FROM public.raw_inventory_items
    WHERE name = 'Precision Rice'
      AND organization_id = 'c0570000-0000-4000-8000-000000000000';

    v_id := app.write_off_stock(v_item, 1000, 'spoiled');

    SELECT total_cost INTO v_cost FROM public.stock_write_offs WHERE id = v_id;
    IF v_cost IS DISTINCT FROM 31.25 THEN
        RAISE EXCEPTION 'writing off 1000 g must cost 31.25, got %', v_cost;
    END IF;

    SELECT unit_cost INTO v_rate FROM public.stock_write_off_lines WHERE write_off_id = v_id;
    IF v_rate IS DISTINCT FROM 0.031250 THEN
        RAISE EXCEPTION 'the write-off line must carry the full rate, got %', v_rate;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. total_cost is a RECORD, not a valuation input.
--
--    Stock value has to fall as stock is consumed; the invoice figure does not
--    move, because the invoice did not change. Anything that made value follow
--    total_cost would report a fully-consumed lot as still worth its bill.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_lot   uuid;
    v_bill  numeric;
    v_value numeric;
    v_left  numeric;
BEGIN
    SELECT b.id, b.total_cost, b.quantity_remaining,
           b.quantity_remaining * b.cost_at_purchase
      INTO v_lot, v_bill, v_left, v_value
    FROM public.inventory_batches b
    JOIN public.raw_inventory_items r ON r.id = b.raw_item_id
    WHERE r.name = 'Precision Rice';

    -- 2000 of 8000 g are gone (1000 consumed, 1000 written off).
    IF v_left IS DISTINCT FROM 6000.000 THEN
        RAISE EXCEPTION 'expected 6000 g left, got %', v_left;
    END IF;
    IF v_bill IS DISTINCT FROM 250.00 THEN
        RAISE EXCEPTION 'the invoice figure must not move when stock is used, got %', v_bill;
    END IF;
    IF v_value IS DISTINCT FROM 187.500000 THEN
        RAISE EXCEPTION 'value must fall with the stock (expected 187.50, got %)', v_value;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A negative bill is refused.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_item   uuid;
BEGIN
    SELECT id INTO v_item FROM public.raw_inventory_items
    WHERE name = 'Precision Rice'
      AND organization_id = 'c0570000-0000-4000-8000-000000000000';

    BEGIN
        INSERT INTO public.inventory_batches
            (organization_id, raw_item_id, quantity_received, quantity_remaining,
             cost_at_purchase, total_cost)
        VALUES ('c0570000-0000-4000-8000-000000000000', v_item, 1, 1, 1, -5);
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a negative invoice total must be refused';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Structural: the rate columns must never be narrowed back.
--
--    This is the assertion that keeps the bug fixed. Every one of these holds
--    currency PER UNIT OF MEASURE, so two decimal places cannot represent a
--    per-gram price and silently truncates it — the failure was invisible for
--    months because nothing ever compared a lot to its invoice.
--
--    Deliberately does not cover sellable_items.price, order_items.unit_price
--    or purchase_order_lines.unit_price: those are currency amounts for one
--    sellable or purchasable unit, where 2dp is correct and more decimals would
--    invite a price nobody can pay.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(table_name || '.' || column_name || ' (scale ' || numeric_scale || ')', ', ')
      INTO v_bad
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
            ('inventory_batches',      'cost_at_purchase'),
            ('inventory_consumption',  'unit_cost'),
            ('stock_write_off_lines',  'unit_cost')
          )
      AND numeric_scale < 6;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'PER-UNIT COST PRECISION LOST: %. These hold currency per unit of '
            'measure, so a per-gram rate is a fraction of a piastre; at 2 '
            'decimals a 250.00 delivery of 8000 g values at 240.00 and the '
            'difference reaches margin, waste cost and stock value (0025).',
            v_bad;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. The fixture is deliberately NOT torn down, and the attempt to do so is
--    what proves the point: the app role holds no DELETE on stock_write_offs or
--    its lines (0023), because a write-off is a historical record. A teardown
--    here failed with "permission denied for table stock_write_off_lines",
--    which is the immutability working rather than a gap in the test.
--
--    Leaving rows behind is safe: this is the last suite in the sequence and
--    the CI database is discarded. Asserted rather than assumed, so nobody
--    later "fixes" it by granting DELETE.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF has_table_privilege('mosaiz_app_user', 'public.stock_write_offs', 'DELETE')
       OR has_table_privilege('mosaiz_app_user', 'public.stock_write_off_lines', 'DELETE') THEN
        RAISE EXCEPTION
            'a write-off has become deletable; it is meant to be a permanent '
            'record, and the FOR ALL permissive policy would cover the DELETE '
            'if the privilege were granted (see 0014, 0019, 0023)';
    END IF;
END;
$$;

SELECT 'cost_precision_verification: all assertions passed' AS result;
