-- ============================================================================
-- Migration 0030: An open tab can be cancelled
-- Mosaiz Mundo ERP
--
-- 0029 gave an order somewhere to live while the table is still eating. It did
-- not give that state a way to END badly. app.void_order finishes with
--
--     WHERE id = p_order_id AND status = 'completed'
--
-- so for an OPEN order the UPDATE matched nothing — and the procedure reads a
-- zero row count as "the RESTRICTIVE policy filtered this row", which is only
-- true for a completed one. A branch manager cancelling a tab a table walked
-- out on was therefore told 'voiding an order is limited to managers'. Both the
-- capability and the diagnosis were wrong.
--
-- WHAT AN OPEN TAB'S STOCK MEANS. The restore loop below works off
-- inventory_consumption, and those rows exist only for lines that were FIRED —
-- which is exactly right without changing a line of it: unfired lines consumed
-- nothing, so there is nothing of theirs to give back, while fired lines took
-- real ingredients and the manager's restore decision applies to them the same
-- way it does on a completed order. Food already cooked is not put back on the
-- shelf; food never started is not conjured onto it.
--
-- Revenue is unaffected either way: an open order was never counted, and a
-- voided one is not counted either.
--
-- The procedure below is 0022's, derived mechanically from that file rather
-- than retyped, with the one WHERE clause changed and nothing else touched —
-- the reason vocabulary, the note normalisation, the error contract, the
-- deterministic lock order and the whole restore loop are byte-identical.
-- Retyping eighty lines of stock restoration to change one clause is how an
-- earlier migration's work silently disappears.
--
-- Depends on: 0022 (this procedure), 0029 (the 'open' status)
-- ============================================================================

BEGIN;

CREATE OR REPLACE PROCEDURE app.void_order(
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
    -- 0030: 'open' joins 'completed' here, and this is the entire change. A tab
    -- a table walked out on, or one opened by mistake, has to be closable — and
    -- until now this UPDATE matched no row for it, so a manager cancelling an
    -- open tab was told that voiding is limited to managers.
    WHERE id = p_order_id AND status IN ('open', 'completed');

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
    'Voids a completed OR open order (0030), recording why and an explicit stock decision. Restores only what was actually consumed, so an open tab gives back the ingredients of its fired lines and nothing for the rest. The 0010 RESTRICTIVE policy gates the UPDATE, so a non-manager updates no row and is refused.';

COMMIT;
