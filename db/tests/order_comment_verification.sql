-- ============================================================================
-- Order comment verification (0028) — runs as mosaiz_app_user under the cogs
-- fixture's CASHIER identity, because taking an order is a cashier's job and
-- checkout is SECURITY INVOKER.
--
-- Notes are the first thing the kitchen actually reads, so the assertions here
-- are less about storage than about the shapes that would quietly lose them:
-- a blank string that is not a note, two identical dishes that must NOT be
-- merged because only one has onions, and the possibility that replacing a
-- 90-line procedure dropped something the previous migration added.
--
-- Run order: after employee_rating_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

-- ----------------------------------------------------------------------------
-- 1. Both levels of note survive a checkout, and reach the right rows.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order   uuid;
    v_note    text;
    v_line    text;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c0117e00-0000-4000-8000-000000000001',
        'note',              'طاولة ٥ — حساسية مكسرات',
        'items', jsonb_build_array(
            jsonb_build_object(
                'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001',
                'quantity', 1,
                'note', 'بدون بصل'))));

    SELECT id, note INTO v_order, v_note FROM public.orders
    WHERE client_offline_id = 'c0117e00-0000-4000-8000-000000000001';

    IF v_note IS DISTINCT FROM 'طاولة ٥ — حساسية مكسرات' THEN
        RAISE EXCEPTION 'the order note must be stored verbatim, got %', v_note;
    END IF;

    SELECT note INTO v_line FROM public.order_items WHERE order_id = v_order;
    IF v_line IS DISTINCT FROM 'بدون بصل' THEN
        RAISE EXCEPTION 'the line note must be stored verbatim, got %', v_line;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A BLANK note is absent, not empty.
--
--    A client that sends "" or "   " means "no note". Storing it as an empty
--    string would make every reader special-case it, and a kitchen ticket would
--    print a blank line where an instruction should be.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_note  text;
    v_line  text;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c0117e00-0000-4000-8000-000000000002',
        'note',              '    ',
        'items', jsonb_build_array(
            jsonb_build_object(
                'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001',
                'quantity', 1,
                'note', ''))));

    SELECT id, note INTO v_order, v_note FROM public.orders
    WHERE client_offline_id = 'c0117e00-0000-4000-8000-000000000002';

    IF v_note IS NOT NULL THEN
        RAISE EXCEPTION 'a whitespace-only order note must be null, got [%]', v_note;
    END IF;

    SELECT note INTO v_line FROM public.order_items WHERE order_id = v_order;
    IF v_line IS NOT NULL THEN
        RAISE EXCEPTION 'an empty line note must be null, got [%]', v_line;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. An order with NO note key at all is unaffected. Every client that predates
--    this migration keeps working.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_note  text;
    v_lines int;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c0117e00-0000-4000-8000-000000000003',
        'items', jsonb_build_array(
            jsonb_build_object(
                'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001',
                'quantity', 2))));

    SELECT id, note INTO v_order, v_note FROM public.orders
    WHERE client_offline_id = 'c0117e00-0000-4000-8000-000000000003';

    IF v_order IS NULL THEN
        RAISE EXCEPTION 'a checkout without notes must still work';
    END IF;
    IF v_note IS NOT NULL THEN
        RAISE EXCEPTION 'an absent note key must leave the note null, got %', v_note;
    END IF;

    SELECT count(*) INTO v_lines FROM public.order_items WHERE order_id = v_order;
    IF v_lines <> 1 THEN
        RAISE EXCEPTION 'expected one line, got %', v_lines;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. THE SAME DISH WITH DIFFERENT NOTES STAYS TWO LINES.
--
--    Two burgers where one has no onions are two different things to cook. If
--    anything ever coalesced them by sellable_item_id, one instruction would be
--    silently discarded — and the one that disappears could be the allergy.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_lines int;
    v_notes text[];
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', 'c0117e00-0000-4000-8000-000000000004',
        'items', jsonb_build_array(
            jsonb_build_object(
                'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001',
                'quantity', 1, 'note', 'بدون بصل'),
            jsonb_build_object(
                'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001',
                'quantity', 1, 'note', 'حار جدًا'))));

    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c0117e00-0000-4000-8000-000000000004';

    SELECT count(*), array_agg(note ORDER BY note)
      INTO v_lines, v_notes
    FROM public.order_items WHERE order_id = v_order;

    IF v_lines <> 2 THEN
        RAISE EXCEPTION
            'the same dish with two different notes must stay two lines, got % '
            '(coalescing them would throw one instruction away)', v_lines;
    END IF;
    IF NOT ('بدون بصل' = ANY(v_notes) AND 'حار جدًا' = ANY(v_notes)) THEN
        RAISE EXCEPTION 'both instructions must survive, got %', v_notes;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Over-length notes are refused by the database.
--
--    A line note that does not fit on a kitchen ticket is not an instruction,
--    and an unbounded text column is one somebody eventually pastes into.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    caught text;
BEGIN
    caught := NULL;
    BEGIN
        CALL app.process_pos_checkout(jsonb_build_object(
            'organization_id',   'c0570000-0000-4000-8000-000000000000',
            'client_offline_id', 'c0117e00-0000-4000-8000-000000000005',
            'note',              repeat('x', 501),
            'items', jsonb_build_array(
                jsonb_build_object(
                    'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001',
                    'quantity', 1))));
    EXCEPTION WHEN check_violation THEN caught := SQLSTATE;
    END;
    IF caught IS NULL THEN
        RAISE EXCEPTION 'an over-long order note must be refused';
    END IF;

    caught := NULL;
    BEGIN
        CALL app.process_pos_checkout(jsonb_build_object(
            'organization_id',   'c0570000-0000-4000-8000-000000000000',
            'client_offline_id', 'c0117e00-0000-4000-8000-000000000006',
            'items', jsonb_build_array(
                jsonb_build_object(
                    'sellable_item_id', 'c0575e11-0000-4000-8000-000000000001',
                    'quantity', 1, 'note', repeat('y', 201)))));
    EXCEPTION WHEN check_violation THEN caught := SQLSTATE;
    END;
    IF caught IS NULL THEN
        RAISE EXCEPTION 'an over-long line note must be refused';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. REGRESSION GUARD: the sale is still attributed.
--
--    0028 replaces the whole 90-line checkout procedure in order to add two
--    fields. The realistic failure is not that notes break — it is that a
--    hand-copied body silently loses something an EARLIER migration added, and
--    nothing notices until a report is quietly wrong. served_by (0026) is the
--    most recent such addition, so it is asserted here rather than assumed.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_served uuid;
BEGIN
    SELECT served_by INTO v_served FROM public.orders
    WHERE client_offline_id = 'c0117e00-0000-4000-8000-000000000001';

    IF v_served IS DISTINCT FROM 'c0570001-0000-4000-8000-000000000001'::uuid THEN
        RAISE EXCEPTION
            'ATTRIBUTION LOST: 0028 replaced process_pos_checkout and dropped '
            'served_by, which 0026 added (expected the cashier, got %)', v_served;
    END IF;
END;
$$;

SELECT 'order_comment_verification: all assertions passed' AS result;
