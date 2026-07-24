-- ============================================================================
-- Stock write-off verification (0023) — runs as mosaiz_app_user, switching
-- between the cogs fixture's CASHIER and BRANCH MANAGER identities, because
-- admin-only is half the design.
--
-- Relies on the state void_verification leaves behind, which makes the
-- arithmetic exact:
--   patty (…f00d-0001): cheap lot 5 @3.00 (expires +2d), dear lot 10 @5.00 (+9d)
--   cheese (…f00d-0002): 94 @0.50 (+30d)
--   inventory_deficits: patty short by 3
--
-- The cheap patty lot expires FIRST, so FIFO always reaches for it before the
-- dear one. That is what makes the named-lot test below meaningful: naming the
-- dear lot must override an ordering that would otherwise not have chosen it.
--
-- Self-asserting; any broken expectation raises and fails CI.
-- Run order: immediately after void_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. A cashier MAY NOT write stock off. The RESTRICTIVE insert policy refuses
--    the header row, so nothing reaches the shelf at all.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    rejected boolean := false;
    v_total  numeric;
    v_rows   int;
BEGIN
    BEGIN
        PERFORM app.write_off_stock(
            'c057f00d-0000-4000-8000-000000000001', 2, 'spoiled');
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier wrote stock off';
    END IF;

    SELECT sum(quantity_remaining) INTO v_total FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_total IS DISTINCT FROM 15.000 THEN
        RAISE EXCEPTION 'a refused write-off must not move stock (expected 15, got %)', v_total;
    END IF;

    SELECT count(*) INTO v_rows FROM public.stock_write_offs;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'a refused write-off must leave no record, got % row(s)', v_rows;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Naming a lot overrides FIFO — the reason p_batch_id exists.
--
--    FIFO would take the cheap lot (it expires in 2 days). This writes off 4
--    from the DEAR lot, which is exactly the expiry case: the crate that went
--    out of date is not necessarily the one FIFO would reach for.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_dear_id  uuid;
    v_id       uuid;
    v_cheap    numeric;
    v_dear     numeric;
    v_lines    int;
    v_cost     numeric;
    v_written  numeric;
    v_short    numeric;
    v_by       uuid;
    v_line_lot uuid;
BEGIN
    SELECT id INTO v_dear_id FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 5.00;

    v_id := app.write_off_stock(
        'c057f00d-0000-4000-8000-000000000001', 4, 'expired', NULL, v_dear_id);

    SELECT quantity_remaining INTO v_cheap FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 3.00;
    SELECT quantity_remaining INTO v_dear FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 5.00;

    IF v_cheap IS DISTINCT FROM 5.000 THEN
        RAISE EXCEPTION 'naming a lot must leave the FIFO-first lot untouched (expected 5, got %)', v_cheap;
    END IF;
    IF v_dear IS DISTINCT FROM 6.000 THEN
        RAISE EXCEPTION 'the named lot must give up exactly 4 (expected 6 left, got %)', v_dear;
    END IF;

    SELECT quantity_written_off, quantity_short, total_cost, written_off_by
      INTO v_written, v_short, v_cost, v_by
    FROM public.stock_write_offs WHERE id = v_id;

    IF v_written IS DISTINCT FROM 4.000 OR v_short IS DISTINCT FROM 0.000 THEN
        RAISE EXCEPTION 'expected 4 written off and none short, got % / %', v_written, v_short;
    END IF;
    -- Priced from the lot it actually came out of, not an average.
    IF v_cost IS DISTINCT FROM 20.00 THEN
        RAISE EXCEPTION 'cost must be 4 x 5.00 = 20.00, got %', v_cost;
    END IF;
    IF v_by IS DISTINCT FROM 'c0570002-0000-4000-8000-000000000002'::uuid THEN
        RAISE EXCEPTION 'the write-off must record who did it, got %', v_by;
    END IF;

    -- Counted and read separately: there is no min(uuid) to collapse them in
    -- one pass, and the count is the assertion that makes reading one row safe.
    SELECT count(*) INTO v_lines
    FROM public.stock_write_off_lines WHERE write_off_id = v_id;
    IF v_lines <> 1 THEN
        RAISE EXCEPTION 'a single-lot write-off must produce one line, got %', v_lines;
    END IF;

    SELECT batch_id INTO v_line_lot
    FROM public.stock_write_off_lines WHERE write_off_id = v_id;
    IF v_line_lot IS DISTINCT FROM v_dear_id THEN
        RAISE EXCEPTION 'the line must name the lot that was drawn';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Without a lot it is FIFO, and the cost is per lot rather than averaged.
--    6 units: 5 from the cheap lot (3.00) then 1 from the dear (5.00) = 20.00.
--    A weighted average over the 11 units on hand would say 6 x 4.09 = 24.55.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id    uuid;
    v_cheap numeric;
    v_dear  numeric;
    v_lines int;
    v_cost  numeric;
BEGIN
    v_id := app.write_off_stock(
        'c057f00d-0000-4000-8000-000000000001', 6, 'prep_error', 'dropped the tray');

    SELECT quantity_remaining INTO v_cheap FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 3.00;
    SELECT quantity_remaining INTO v_dear FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 5.00;

    IF v_cheap IS DISTINCT FROM 0.000 THEN
        RAISE EXCEPTION 'FIFO must empty the soonest-expiring lot first (got % left)', v_cheap;
    END IF;
    IF v_dear IS DISTINCT FROM 5.000 THEN
        RAISE EXCEPTION 'FIFO must then take 1 from the dear lot (expected 5 left, got %)', v_dear;
    END IF;

    SELECT count(*) INTO v_lines FROM public.stock_write_off_lines WHERE write_off_id = v_id;
    IF v_lines <> 2 THEN
        RAISE EXCEPTION 'a write-off spanning two lots must record two lines, got %', v_lines;
    END IF;

    SELECT total_cost INTO v_cost FROM public.stock_write_offs WHERE id = v_id;
    IF v_cost IS DISTINCT FROM 20.00 THEN
        RAISE EXCEPTION 'cost must be 5x3.00 + 1x5.00 = 20.00, got %', v_cost;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. The reason is required and closed, and 'other' must say what.
--    Every case here must fail and leave both the shelf and the log untouched.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before_stock numeric;
    v_before_rows  int;
    v_after_stock  numeric;
    v_after_rows   int;
    n              int;
    caught         text;
    -- description, reason, note, quantity, expected SQLSTATE
    cases text[][] := ARRAY[
        ['a null reason',                   NULL,        NULL,             '1', '22023'],
        ['an empty reason',                 '',          NULL,             '1', '22023'],
        ['a whitespace-only reason',        '   ',       NULL,             '1', '22023'],
        ['a reason outside the vocabulary', 'shrinkage', NULL,             '1', '23514'],
        ['a plausible near-miss',           'expiry',    NULL,             '1', '23514'],
        ['other with no note',              'other',     NULL,             '1', '23514'],
        ['other with a blank note',         'other',     '   ',            '1', '23514'],
        ['a note longer than 500 chars',    'spoiled',   repeat('x', 501), '1', '23514'],
        ['a zero quantity',                 'spoiled',   NULL,             '0', '22023'],
        ['a negative quantity',             'spoiled',   NULL,            '-1', '22023']
    ];
BEGIN
    SELECT sum(quantity_remaining) INTO v_before_stock FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    SELECT count(*) INTO v_before_rows FROM public.stock_write_offs;

    FOR n IN 1 .. array_length(cases, 1) LOOP
        caught := NULL;
        BEGIN
            PERFORM app.write_off_stock(
                'c057f00d-0000-4000-8000-000000000001',
                cases[n][4]::numeric, cases[n][2], cases[n][3]);
        EXCEPTION WHEN OTHERS THEN
            caught := SQLSTATE;
        END;

        IF caught IS NULL THEN
            RAISE EXCEPTION 'write_off_stock accepted %, which must be rejected', cases[n][1];
        END IF;
        IF caught <> cases[n][5] THEN
            RAISE EXCEPTION 'rejecting % must raise %, got %', cases[n][1], cases[n][5], caught;
        END IF;
    END LOOP;

    -- Every rejection rolled back whole. A write-off that logged a header and
    -- then failed validation would leave a phantom loss in the report.
    SELECT sum(quantity_remaining) INTO v_after_stock FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    SELECT count(*) INTO v_after_rows FROM public.stock_write_offs;

    IF v_after_stock IS DISTINCT FROM v_before_stock THEN
        RAISE EXCEPTION 'a rejected write-off moved stock (% -> %)', v_before_stock, v_after_stock;
    END IF;
    IF v_after_rows <> v_before_rows THEN
        RAISE EXCEPTION 'a rejected write-off left a record behind';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. staff_meal is a first-class reason, not a loophole. Stock eaten by staff
--    still has to leave the books, or it resurfaces as mystery shrinkage at the
--    next stocktake — attributed to nobody and explainable by no one.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id     uuid;
    v_cheese numeric;
    v_cost   numeric;
BEGIN
    v_id := app.write_off_stock(
        'c057f00d-0000-4000-8000-000000000002', 1, 'staff_meal', 'closing shift');

    SELECT sum(quantity_remaining) INTO v_cheese FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';
    IF v_cheese IS DISTINCT FROM 93.000 THEN
        RAISE EXCEPTION 'a staff meal must draw stock down like any other (expected 93, got %)', v_cheese;
    END IF;

    SELECT total_cost INTO v_cost FROM public.stock_write_offs WHERE id = v_id;
    IF v_cost IS DISTINCT FROM 0.50 THEN
        RAISE EXCEPTION 'expected 1 x 0.50 = 0.50, got %', v_cost;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Discarding more than the books hold is allowed, and the excess lands on
--    the SAME reconciliation surface a short sale uses.
--
--    5 patties remain; 8 are binned. The books understated by 3 — that is a
--    real situation, and refusing it would block a legitimate write-off while
--    someone stands over a bin.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id      uuid;
    v_written numeric;
    v_short   numeric;
    v_req     numeric;
    v_cost    numeric;
    v_stock   numeric;
    v_deficit numeric;
BEGIN
    v_id := app.write_off_stock(
        'c057f00d-0000-4000-8000-000000000001', 8, 'spoiled', 'walk-in failed overnight');

    SELECT quantity_requested, quantity_written_off, quantity_short, total_cost
      INTO v_req, v_written, v_short, v_cost
    FROM public.stock_write_offs WHERE id = v_id;

    IF v_written IS DISTINCT FROM 5.000 OR v_short IS DISTINCT FROM 3.000 THEN
        RAISE EXCEPTION 'expected 5 drawn and 3 short, got % / %', v_written, v_short;
    END IF;
    IF v_req IS DISTINCT FROM 8.000 THEN
        RAISE EXCEPTION 'the requested quantity must be preserved, got %', v_req;
    END IF;
    -- Only what actually existed is costed; the shortfall never had a lot.
    IF v_cost IS DISTINCT FROM 25.00 THEN
        RAISE EXCEPTION 'cost must be 5 x 5.00 = 25.00, got %', v_cost;
    END IF;

    SELECT COALESCE(sum(quantity_remaining), 0) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_stock IS DISTINCT FROM 0.000 THEN
        RAISE EXCEPTION 'the shelf must be empty after this (got %)', v_stock;
    END IF;

    -- 3 from the short sale in cogs_verification, plus 3 from this write-off.
    SELECT missing_quantity INTO v_deficit FROM public.inventory_deficits
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_deficit IS DISTINCT FROM 6.000 THEN
        RAISE EXCEPTION 'the excess must add to the existing deficit (expected 6, got %)', v_deficit;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Naming a lot that has nothing left is an error, not a silent no-op.
--    Recording a write-off of zero against a full shortfall would misreport
--    both the loss and the deficit.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_lot    uuid;
    v_rows   int;
    v_before int;
BEGIN
    SELECT count(*) INTO v_before FROM public.stock_write_offs;

    SELECT id INTO v_lot FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001' AND cost_at_purchase = 3.00;

    BEGIN
        PERFORM app.write_off_stock(
            'c057f00d-0000-4000-8000-000000000001', 1, 'expired', NULL, v_lot);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'writing off from an empty lot must be refused';
    END IF;

    SELECT count(*) INTO v_rows FROM public.stock_write_offs;
    IF v_rows <> v_before THEN
        RAISE EXCEPTION 'the refused write-off must leave no record';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Another tenant's ingredient is "not found", not "forbidden" — RLS makes it
--    invisible, so ids cannot be probed across organizations.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        PERFORM app.write_off_stock(
            'a11cf00d-000f-400f-800f-00000000000f', 1, 'spoiled');
    EXCEPTION WHEN no_data_found THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'CROSS-TENANT HOLE: wrote off another organization''s ingredient';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. A write-off is a financial record: the app role can create and read one,
--    and can neither edit nor erase it. Asserted against the grants themselves,
--    because this is a property of the privilege set rather than of any
--    statement we happen to run.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['stock_write_offs', 'stock_write_off_lines'] LOOP
        IF NOT has_table_privilege('mosaiz_app_user', 'public.' || t, 'INSERT')
           OR NOT has_table_privilege('mosaiz_app_user', 'public.' || t, 'SELECT') THEN
            RAISE EXCEPTION '% must be insertable and readable by the app role', t;
        END IF;
        IF has_table_privilege('mosaiz_app_user', 'public.' || t, 'UPDATE') THEN
            RAISE EXCEPTION '% must not be editable: a write-off is a historical record', t;
        END IF;
        IF has_table_privilege('mosaiz_app_user', 'public.' || t, 'DELETE') THEN
            RAISE EXCEPTION '% must not be deletable — and note that the FOR ALL '
                'permissive policy would cover DELETE if the privilege were ever '
                'granted, so granting it needs a RESTRICTIVE gate in the same '
                'migration (see 0014, 0019)', t;
        END IF;
    END LOOP;
END;
$$;

SELECT 'write_off_verification: all assertions passed' AS result;
