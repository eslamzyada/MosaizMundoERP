-- ============================================================================
-- Migration 0024: Retire an ingredient, and correct a mis-keyed lot cost
-- Mosaiz Mundo ERP
--
-- Two gaps found in use, both about the ordinary act of fixing a mistake.
--
-- 1. AN INGREDIENT COULD NEVER BE REMOVED. There was no DELETE privilege on
--    raw_inventory_items at all, so a typo created at 9am was permanent.
--
-- 2. A LOT'S COST COULD NEVER BE CORRECTED. cost_at_purchase is keyed in when
--    stock is received; key 130.00 instead of 13.00 and the stock value, the
--    reorder economics and every supplier price comparison are wrong forever.
--
-- ----------------------------------------------------------------------------
-- WHY DELETE IS CONDITIONAL, NOT ABSOLUTE
--
-- Seven tables reference raw_inventory_items, every one of them ON DELETE NO
-- ACTION: inventory_batches, bill_of_materials, inventory_deficits,
-- stocktake_items, inventory_consumption, purchase_order_lines and
-- stock_write_offs. That is deliberate. Cascading would erase recorded COGS,
-- the consumption ledger a food-safety recall depends on, and past stocktakes —
-- silently changing historical profit figures long after they were reported.
--
-- So an ingredient that has been USED cannot be deleted, and should not be.
-- What it can be is ARCHIVED: is_active = false hides it from every picker
-- while leaving the history it participates in intact. That is exactly the
-- pattern suppliers have used since 0020, for exactly the same reason.
--
-- An ingredient that has NEVER been used has no history to protect, and there
-- the honest answer to "delete this typo" is to delete it. The database decides
-- which case applies — the foreign keys already encode it, so the procedure
-- does not need to re-derive the rule and cannot disagree with them.
--
-- THE GRANT NEEDS ITS OWN GATE. The permissive user_belongs_to_org policy is
-- FOR ALL, which covers DELETE. Granting the privilege without a RESTRICTIVE
-- delete policy would let ANY member of the organization delete ingredients —
-- the same trap 0014 and 0019 had to step around when they granted DELETE.
--
-- ----------------------------------------------------------------------------
-- WHY CORRECTING A COST IS A FUNCTION AND NOT AN UPDATE
--
-- inventory_batches carries require_sell_update (RESTRICTIVE, UPDATE), because
-- checkout has to decrement quantity_remaining as a CASHIER. A plain UPDATE of
-- cost_at_purchase would therefore be permitted by the database for a cashier;
-- only the API route would object, and the API is not the boundary. Routing the
-- correction through a SECURITY INVOKER function that checks
-- app.user_can_administer itself puts the rule where it belongs.
--
-- WHAT A CORRECTION DOES NOT TOUCH: order_items.cost_at_sale. 0015 captures the
-- cost of goods sold at the moment of the sale precisely so that later price
-- changes cannot rewrite history. A correction therefore moves current stock
-- value, future deductions and purchase-price history — and leaves every margin
-- figure ever reported exactly as it was. That property is asserted in
-- db/tests/ingredient_lifecycle_verification.sql, because it is the difference
-- between a correction and a falsification.
--
-- Depends on: 0009 (raw items), 0010 (role policies), 0015 (cost at sale)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Retire, rather than erase.
-- ----------------------------------------------------------------------------
ALTER TABLE public.raw_inventory_items
    ADD COLUMN is_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.raw_inventory_items.is_active IS
    'False for a retired ingredient (0024): hidden from pickers and reorder suggestions, but still counted wherever it holds stock and still present in every historical record. Archiving is the answer for anything that has been used; a never-used ingredient can simply be deleted.';

-- Pickers and reorder suggestions ask for the active ones; the partial index
-- keeps that the cheap path without paying for the archived rows.
CREATE INDEX raw_inventory_items_active_idx
    ON public.raw_inventory_items (organization_id)
    WHERE is_active;

-- ----------------------------------------------------------------------------
-- 2. DELETE, gated.
--
--    Without require_admin_delete the FOR ALL permissive policy would cover the
--    new privilege and any member could delete ingredients. The referential
--    integrity above stops history being destroyed; this stops the wrong people
--    destroying the rest.
-- ----------------------------------------------------------------------------
CREATE POLICY require_admin_delete ON public.raw_inventory_items
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT DELETE ON public.raw_inventory_items TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Correcting a mis-keyed lot cost.
--
--    Returns the PREVIOUS cost so the caller can report what actually changed —
--    a correction the user cannot see the before-and-after of is one they have
--    to take on trust.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.correct_batch_cost(
    p_batch_id uuid,
    p_new_cost numeric
)
RETURNS numeric
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org      uuid;
    v_old_cost numeric;
BEGIN
    IF p_batch_id IS NULL OR p_new_cost IS NULL OR p_new_cost < 0 THEN
        RAISE EXCEPTION 'correct_batch_cost requires a lot and a cost of zero or more'
            USING ERRCODE = 'invalid_parameter_value';                -- 22023
    END IF;

    -- RLS makes another tenant's lot invisible, so this is "not found" rather
    -- than "forbidden": ids cannot be probed across organizations.
    SELECT organization_id, cost_at_purchase INTO v_org, v_old_cost
    FROM public.inventory_batches WHERE id = p_batch_id;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'stock lot % not found in this organization', p_batch_id
            USING ERRCODE = 'no_data_found';                          -- P0002
    END IF;

    -- The check that matters. require_sell_update would let a cashier through
    -- on a bare UPDATE, because checkout needs to move quantity_remaining as
    -- one; the cost is a different question and gets a different answer.
    IF NOT app.user_can_administer(v_org) THEN
        RAISE EXCEPTION 'correcting a stock cost is limited to managers'
            USING ERRCODE = 'insufficient_privilege';                 -- 42501
    END IF;

    -- Serialize with sales, stocktakes and write-offs on this ingredient, using
    -- the key every other stock mover uses so the lock actually collides.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || (
        SELECT raw_item_id::text FROM public.inventory_batches WHERE id = p_batch_id
    )));

    UPDATE public.inventory_batches
    SET cost_at_purchase = p_new_cost
    WHERE id = p_batch_id;

    RETURN v_old_cost;
END;
$$;

COMMENT ON FUNCTION app.correct_batch_cost(uuid, numeric) IS
    'Corrects a stock lot''s cost_at_purchase (0024) and returns the previous value. Moves current stock value, future FIFO deductions and purchase-price history; deliberately does NOT touch order_items.cost_at_sale, so no margin figure ever reported is rewritten. Admin-only, checked in-function because require_sell_update permits a cashier to UPDATE lots. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION app.correct_batch_cost(uuid, numeric) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.correct_batch_cost(uuid, numeric) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
