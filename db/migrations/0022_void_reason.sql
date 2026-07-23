-- ============================================================================
-- Migration 0022: Why an order was voided
-- Mosaiz Mundo ERP
--
-- 0018 recorded WHO voided an order and WHETHER the stock came back. It never
-- recorded WHY, and without that a void is an unreadable event: a till that
-- voids twenty orders a week might have a cashier who needs training, a kitchen
-- that plates the wrong dish, or a menu whose two similar burgers get confused
-- at the button. All three look identical in the data, so none of them get
-- fixed.
--
-- The reason is a FIXED VOCABULARY, not free text. Free text is easier for the
-- person standing at the till and useless afterwards: "wrong order", "mistake"
-- and "خطأ" are the same event spelled three ways, and nothing can be counted.
-- A closed list is the only version of this feature that answers a question.
--
-- WHY THESE SEVEN. Each one has a different owner, which is the test for
-- whether a category earns its place:
--
--   wrong_item          the item rung up was not the item wanted    -> training / menu layout
--   duplicate           the same order was entered twice            -> process or a client bug
--   customer_cancelled  the customer changed their mind or left     -> nobody's fault
--   kitchen_error       the food was made wrong and is being remade -> kitchen
--   customer_complaint  the customer rejected food already served   -> recipe / quality
--   test_order          a training or test transaction              -> excluded from analysis
--   other               anything else — a note is REQUIRED
--
-- There is deliberately no 'walkout' code: a walkout is already expressible as
-- customer_cancelled with stock_restored = false, which says exactly what
-- happened — the customer left AND the food had been made. Adding a code for a
-- combination the data already carries would let the two disagree.
--
-- 'other' is allowed because a closed list that cannot express a real event
-- pushes people into whichever wrong category is nearest, which corrupts the
-- categories that matter. It requires a note so it stays an escape hatch rather
-- than the default — an empty note is rejected by the database, not just by the
-- form.
--
-- REASON AND STOCK STAY INDEPENDENT. It is tempting to derive one from the
-- other (surely kitchen_error means the food was made?) but the exceptions are
-- real: a kitchen error caught at the pass before plating, a cancellation after
-- the food is up. A CHECK encoding my guess about a kitchen I have never stood
-- in would refuse a legitimate void mid-service, which is the one failure this
-- feature must never cause. Suspicious combinations belong in a report, not in
-- a constraint.
--
-- The voided <-> reason equivalence IS enforced, because it is not a guess:
-- every void from here on goes through the procedure below, and an order that
-- is not voided has no reason to hold one. No pre-existing voided rows exist to
-- backfill (verified against the running database), so the constraint can be
-- strict from the start rather than tolerating a legacy NULL forever.
--
-- Depends on: 0018 (void_order, the void metadata columns)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The columns.
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN void_reason text,
    ADD COLUMN void_note   text;

COMMENT ON COLUMN public.orders.void_reason IS
    'Why a voided order was voided, from the fixed vocabulary in orders_void_reason_check (0022). NULL if and only if the order is not voided. Independent of stock_restored: the two together distinguish e.g. a pre-cook cancellation from a walkout.';

COMMENT ON COLUMN public.orders.void_note IS
    'Free text accompanying a void. Required when void_reason = ''other'' (that is the price of the escape hatch), optional otherwise, and never present without a reason.';

-- ----------------------------------------------------------------------------
-- 2. Constraints.
--
--    Named explicitly rather than left to Postgres, because the API maps 23514
--    to a 400 and the constraint name is what tells the user WHICH rule they
--    broke — "pick a reason from the list" and "that reason needs a note" are
--    different corrections.
-- ----------------------------------------------------------------------------

-- Every void has a reason; nothing else may carry one.
ALTER TABLE public.orders
    ADD CONSTRAINT orders_void_reason_matches_status
    CHECK ((status = 'voided') = (void_reason IS NOT NULL));

-- The vocabulary. This is the source of truth: the API's VOID_REASONS constant
-- is asserted against this constraint by a backend test, so the two cannot
-- drift into a state where the form offers a value the database rejects.
ALTER TABLE public.orders
    ADD CONSTRAINT orders_void_reason_check
    CHECK (void_reason IS NULL OR void_reason IN (
        'wrong_item',
        'duplicate',
        'customer_cancelled',
        'kitchen_error',
        'customer_complaint',
        'test_order',
        'other'
    ));

-- 'other' must say what. Whitespace is not an explanation, so the emptiness
-- test trims first.
ALTER TABLE public.orders
    ADD CONSTRAINT orders_void_note_required_for_other
    CHECK (void_reason IS DISTINCT FROM 'other'
           OR btrim(coalesce(void_note, '')) <> '');

-- A note with no reason is an orphan, and an unbounded one is a text field
-- someone will eventually paste a receipt into. Both are cheap to refuse.
ALTER TABLE public.orders
    ADD CONSTRAINT orders_void_note_wellformed
    CHECK (void_note IS NULL
           OR (void_reason IS NOT NULL AND char_length(void_note) <= 500));

-- ----------------------------------------------------------------------------
-- 3. Reporting index.
--
--    "Voids by reason over the last month" scans by time and groups by reason.
--    Partial on the voided rows only: voids are a small minority of orders, and
--    an index that ignores the completed ones stays small enough to stay in
--    cache. organization_id leads it because RLS filters by org first.
-- ----------------------------------------------------------------------------
CREATE INDEX idx_orders_voided_reason
    ON public.orders (organization_id, voided_at DESC, void_reason)
    WHERE status = 'voided';

-- ----------------------------------------------------------------------------
-- 4. The procedure gains the reason.
--
--    Replacing the signature rather than adding an overload: two callable forms
--    would mean the reasonless one still works, and a rule that can be skipped
--    by calling the old function is not a rule. Dropping it makes every caller
--    supply a reason or fail to compile/execute — which is the point.
-- ----------------------------------------------------------------------------
DROP PROCEDURE app.void_order(uuid, boolean);

CREATE PROCEDURE app.void_order(
    p_order_id      uuid,
    p_restore_stock boolean,
    p_void_reason   text,
    p_void_note     text DEFAULT NULL
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_status  text;
    v_updated integer;
    v_item    record;
    v_note    text;
BEGIN
    IF p_order_id IS NULL OR p_restore_stock IS NULL THEN
        RAISE EXCEPTION 'void_order requires an order id and an explicit stock decision';
    END IF;

    -- Checked here, ahead of everything, so the caller is told the argument is
    -- missing rather than discovering it as a constraint violation three
    -- statements later. Which VALUES are legal is left to the CHECK — one list,
    -- in one place.
    IF p_void_reason IS NULL OR btrim(p_void_reason) = '' THEN
        RAISE EXCEPTION 'void_order requires a reason'
            USING ERRCODE = 'invalid_parameter_value';             -- 22023
    END IF;

    -- Blank is not a note. Normalising here means the CHECK sees NULL rather
    -- than '   ', so "required when other" cannot be satisfied with spaces.
    v_note := NULLIF(btrim(p_void_note), '');

    -- SELECT is ungated, so any member of the org can see the order. The read
    -- also tells apart "not there" from "already voided" for the error contract.
    SELECT status INTO v_status
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
    --
    -- Note the ordering this produces: a cashier with an invalid reason is told
    -- they may not void, not that their reason was wrong. The row never reaches
    -- the CHECK, so they learn nothing about the vocabulary from being refused.
    UPDATE public.orders
    SET status         = 'voided',
        voided_at      = now(),
        voided_by      = NULLIF(current_setting('app.current_user_id', true), '')::uuid,
        stock_restored = p_restore_stock,
        void_reason    = p_void_reason,
        void_note      = v_note
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

COMMENT ON PROCEDURE app.void_order(uuid, boolean, text, text) IS
    'Voids a completed order. p_restore_stock: true returns each consumed quantity to its original lot (exact reversal via the 0017 ledger, preserving expiry and cost); false leaves stock deducted (food was made). p_void_reason is required and must be in the orders_void_reason_check vocabulary; p_void_note is required only for ''other''. Admin-only via the 0010 orders UPDATE policy; SECURITY INVOKER.';

-- ----------------------------------------------------------------------------
-- 5. Privileges, per convention. The DROP took the old grant with it, so the
--    new signature has to be granted afresh.
-- ----------------------------------------------------------------------------
REVOKE ALL ON PROCEDURE app.void_order(uuid, boolean, text, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON PROCEDURE app.void_order(uuid, boolean, text, text) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
