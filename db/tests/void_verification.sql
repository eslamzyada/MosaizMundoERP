-- ============================================================================
-- Order void verification (0018, extended by 0022) — runs as mosaiz_app_user,
-- switching between the fixture's CASHIER and BRANCH MANAGER identities,
-- because the whole point of the void design is that those two roles get
-- different answers.
--
-- Relies on the state cogs_verification leaves behind (its three orders and
-- their consumption rows), which makes the arithmetic here exact:
--   order -0001: 8 patties drawn as 5 @3.00 (cheap lot) + 3 @5.00 (dear lot)
--   order -0002: 7 patties drawn @5.00, 3 short (deficit), + a recipe-less item
--   order -0003: 6 cheese drawn @0.50 from the 100-unit lot (now 94)
--   stock now:  cheap patty lot 0, dear patty lot 0, cheese 94
--
-- Since 0022 every void also carries a REASON from a closed vocabulary, so the
-- sections below both supply one and prove it cannot be skipped, faked or
-- left blank.
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
    v_reason  text;
    v_cheese  numeric;
    v_order   uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000003';

    BEGIN
        CALL app.void_order(v_order, true, 'wrong_item');
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier voided an order';
    END IF;

    SELECT status, void_reason INTO v_status, v_reason
    FROM public.orders WHERE id = v_order;
    IF v_status <> 'completed' THEN
        RAISE EXCEPTION 'the refused void must leave the order completed, got %', v_status;
    END IF;
    -- The refusal is total: no half-written reason survives it.
    IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION 'a refused void must leave void_reason null, got %', v_reason;
    END IF;

    SELECT sum(quantity_remaining) INTO v_cheese FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';
    IF v_cheese IS DISTINCT FROM 94.000 THEN
        RAISE EXCEPTION 'the refused void must not move stock (expected 94, got %)', v_cheese;
    END IF;

    -- And an order that does not exist is "not found", not "not permitted".
    rejected := false;
    BEGIN
        CALL app.void_order('00000000-0000-4000-8000-0000000000ff', true, 'wrong_item');
    EXCEPTION WHEN no_data_found THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'voiding a nonexistent order must raise no_data_found';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. (0022) The reason is required, closed, and cannot be faked — asserted as
--    the MANAGER, so every rejection below is about the reason itself and not
--    about the role. Every attempt here must fail, leaving order -0003
--    completed and its cheese untouched for section 5.
--
--    This matters more than it looks: the reason is only worth collecting if it
--    cannot be dodged. A vocabulary the caller can bypass with an empty string
--    is free text wearing a costume.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_order  uuid;
    v_status text;
    v_cheese numeric;
    n        int;
    caught   text;
    -- description, reason, note, expected SQLSTATE
    cases    text[][] := ARRAY[
        ['a null reason',                  NULL,        NULL,            '22023'],
        ['an empty reason',                '',          NULL,            '22023'],
        ['a whitespace-only reason',       '   ',       NULL,            '22023'],
        ['a reason outside the vocabulary','shrinkage', NULL,            '23514'],
        ['a plausible-looking near-miss',  'wrongitem', NULL,            '23514'],
        ['other with no note',             'other',     NULL,            '23514'],
        ['other with a blank note',        'other',     '   ',           '23514'],
        ['a note longer than 500 chars',   'wrong_item', repeat('x',501),'23514']
    ];
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000003';

    FOR n IN 1 .. array_length(cases, 1) LOOP
        caught := NULL;
        BEGIN
            CALL app.void_order(v_order, true, cases[n][2], cases[n][3]);
        EXCEPTION WHEN OTHERS THEN
            caught := SQLSTATE;
        END;

        IF caught IS NULL THEN
            RAISE EXCEPTION 'void_order accepted %, which must be rejected', cases[n][1];
        END IF;
        IF caught <> cases[n][4] THEN
            RAISE EXCEPTION 'rejecting % must raise %, got %',
                cases[n][1], cases[n][4], caught;
        END IF;
    END LOOP;

    -- Every one of those rejections rolled back completely. A void that fails
    -- validation AFTER flipping the status would leave an order voided with no
    -- reason — precisely the state 0022 exists to make impossible.
    SELECT status INTO v_status FROM public.orders WHERE id = v_order;
    IF v_status <> 'completed' THEN
        RAISE EXCEPTION 'a rejected void must leave the order completed, got %', v_status;
    END IF;

    SELECT sum(quantity_remaining) INTO v_cheese FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';
    IF v_cheese IS DISTINCT FROM 94.000 THEN
        RAISE EXCEPTION 'a rejected void must not restore stock (expected 94, got %)', v_cheese;
    END IF;
END;
$$;

-- A reason may not be attached to an order that is still live. Written as a
-- direct UPDATE by a manager, who is allowed to update orders — so this proves
-- the CONSTRAINT holds it, not the procedure.
DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000003';

    BEGIN
        UPDATE public.orders SET void_reason = 'wrong_item' WHERE id = v_order;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a completed order must not be allowed to carry a void reason';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A manager voids the two-lot sale WITH restore: every unit goes back to the
--    exact lot it came from. The cheap lot was emptied by this sale alone, so it
--    must return to 5; the dear lot gave it 3, so it returns to 3 (its other 7
--    are still out with order -0002).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order    uuid;
    v_cheap    numeric;
    v_dear     numeric;
    v_restored boolean;
    v_by       uuid;
    v_reason   text;
    v_note     text;
    v_ledger   int;
    v_cogs     numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000001';

    CALL app.void_order(v_order, true, 'wrong_item');

    SELECT stock_restored, voided_by, void_reason, void_note
      INTO v_restored, v_by, v_reason, v_note
    FROM public.orders WHERE id = v_order AND status = 'voided' AND voided_at IS NOT NULL;
    IF v_restored IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'void must record status, timestamp and the restore decision';
    END IF;
    IF v_by IS DISTINCT FROM 'c0570002-0000-4000-8000-000000000002'::uuid THEN
        RAISE EXCEPTION 'void must record who did it, got %', v_by;
    END IF;
    IF v_reason IS DISTINCT FROM 'wrong_item' THEN
        RAISE EXCEPTION 'void must record why, got %', v_reason;
    END IF;
    -- A note is optional for every reason except 'other'; absent means absent,
    -- not an empty string that reporting would have to special-case.
    IF v_note IS NOT NULL THEN
        RAISE EXCEPTION 'an omitted note must be null, got %', v_note;
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
-- 4. Re-voiding is refused — and, crucially, does not restore twice. A silent
--    no-op here would be tolerable; a second restore would invent 8 patties.
--    Since 0022, a refused re-void must also leave the ORIGINAL reason intact:
--    the second attempt names a different cause, and letting it through would
--    rewrite history to whatever the last person to try happened to pick.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
    v_stock  numeric;
    v_reason text;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000001';

    BEGIN
        CALL app.void_order(v_order, true, 'duplicate');
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

    SELECT void_reason INTO v_reason FROM public.orders WHERE id = v_order;
    IF v_reason IS DISTINCT FROM 'wrong_item' THEN
        RAISE EXCEPTION 'a refused re-void must not rewrite the reason (got %)', v_reason;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Voiding WITHOUT restore: the food was made, the ingredients are gone. The
--    money is corrected; the shelf is not touched.
--
--    Voided as 'other' with a note, which is the escape hatch working as
--    designed — a comped meal is a real event that none of the six named causes
--    describes, and forcing it into "customer_complaint" would be a lie in the
--    one report this data exists to feed. The note is stored TRIMMED.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order  uuid;
    v_cheese numeric;
    v_flag   boolean;
    v_reason text;
    v_note   text;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000003';

    CALL app.void_order(v_order, false, 'other', '   comped for an opening-day guest   ');

    SELECT stock_restored, void_reason, void_note INTO v_flag, v_reason, v_note
    FROM public.orders WHERE id = v_order AND status = 'voided';
    IF v_flag IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'the no-restore decision must be recorded as false';
    END IF;
    IF v_reason IS DISTINCT FROM 'other' THEN
        RAISE EXCEPTION 'expected reason other, got %', v_reason;
    END IF;
    IF v_note IS DISTINCT FROM 'comped for an opening-day guest' THEN
        RAISE EXCEPTION 'the note must be stored trimmed, got [%]', v_note;
    END IF;

    SELECT sum(quantity_remaining) INTO v_cheese FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';
    IF v_cheese IS DISTINCT FROM 94.000 THEN
        RAISE EXCEPTION 'a no-restore void must leave stock deducted (expected 94, got %)', v_cheese;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Voiding the SHORT sale with restore: only the 7 units actually drawn come
--    back — the dear lot lands on exactly its received quantity, proving the
--    restore respects the lot's CHECK bound. The 3-unit deficit is deliberately
--    untouched: that stock never existed, so there is nothing to put back, and
--    the running total is stocktake's to reconcile.
--
--    Carries a note against a NAMED reason, proving notes are optional context
--    on any void rather than a field that only exists to prop up 'other'.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order   uuid;
    v_dear    numeric;
    v_total   numeric;
    v_deficit numeric;
    v_note    text;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000002';

    CALL app.void_order(v_order, true, 'customer_cancelled', 'left before the order was fired');

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

    SELECT void_note INTO v_note FROM public.orders WHERE id = v_order;
    IF v_note IS DISTINCT FROM 'left before the order was fired' THEN
        RAISE EXCEPTION 'a named reason must be able to carry a note too, got %', v_note;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. (0022) The reason survives, and the two decisions stay independent.
--
--    The independence claim is asserted STRUCTURALLY rather than by example,
--    because what must hold is the absence of a rule: no constraint may tie
--    void_reason to stock_restored. It is a tempting rule to add — surely
--    kitchen_error means the food was made? — and adding it would refuse a
--    legitimate void mid-service, which is the one failure this feature must
--    never cause. A kitchen error caught at the pass restores stock; a
--    cancellation after the food is up does not. Both are real.
--
--    The pairing customer_cancelled + stock_restored = false is what a walkout
--    looks like, which is why walkout needs no code of its own.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
    v_bad    int;
BEGIN
    SELECT count(*) INTO v_bad
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.orders'::regclass
      AND contype = 'c'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%void_reason%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%stock_restored%';
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'a constraint now ties the void reason to the stock decision; '
            'that forbids real voids (kitchen error caught at the pass, '
            'cancellation after plating) — flag the combination in a report instead';
    END IF;

    -- A void keeps its reason for good: erasing it would leave a voided order
    -- the equivalence constraint says cannot exist.
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'c057c0de-0000-4000-8000-000000000001';
    BEGIN
        UPDATE public.orders SET void_reason = NULL WHERE id = v_order;
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a voided order must not be allowed to drop its reason';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. (0022) The reason is actually reportable — the reason this feature exists.
--    Three voids, three distinct causes, and the money attached to each.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_causes int;
    v_named  int;
BEGIN
    SELECT count(DISTINCT void_reason) INTO v_causes
    FROM public.orders WHERE status = 'voided';
    IF v_causes <> 3 THEN
        RAISE EXCEPTION 'expected three distinct void causes to report on, got %', v_causes;
    END IF;

    -- Nothing voided may be missing its cause, which is what makes a
    -- "voids by reason" total add up to the voided total.
    SELECT count(*) INTO v_named
    FROM public.orders WHERE status = 'voided' AND void_reason IS NULL;
    IF v_named <> 0 THEN
        RAISE EXCEPTION '% voided orders have no reason — the report cannot balance', v_named;
    END IF;
END;
$$;

SELECT 'void_verification: all assertions passed' AS result;
