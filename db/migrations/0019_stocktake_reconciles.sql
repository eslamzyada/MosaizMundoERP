-- ============================================================================
-- Migration 0019: Make posting a stocktake actually reconcile the books
-- Mosaiz Mundo ERP
--
-- Counting the shelf exists to make the system agree with reality. Posting a
-- stocktake did that in only one direction:
--
--   * Found MORE than the books said -> an adjustment lot was added, and
--     on-hand rose to match the count. Correct.
--   * Found LESS than the books said -> a deficit was recorded and the lots
--     were left untouched, so the system went on reporting stock that is not
--     on the shelf.
--
-- Verified before writing this: with one 1000g lot, counting 800 and posting
-- left on-hand at 1000 with a 200 deficit beside it. Count again next week and
-- the deficit becomes 400 while the books still claim 1000 — the discrepancy
-- accumulates and never corrects, which is the opposite of reconciliation.
--
-- THE COUNT WINS. A negative variance now draws the lots down FIFO (earliest
-- expiry, then oldest received — the same order sales consume in), so after
-- posting, on-hand equals what was counted.
--
-- Only stock the books claim but no lot actually holds can survive as a
-- deficit. That residue is real: it means the ledger was already overstated
-- beyond what any lot can account for, which is exactly what a deficit is for.
--
-- POSTING ALSO CLEARS THE DEFICIT for every item counted. inventory_deficits
-- records stock "awaiting reconciliation" (0013) — and a physical count IS that
-- reconciliation. Clearing happens for every counted item, including
-- zero-variance ones: counting an item and finding the books right also settles
-- the question. Leaving the old figure would double-count the same discrepancy,
-- once as a deficit and once as the drawdown that answers it.
--
-- Deficits are cleared with DELETE rather than a zero, so "open deficits" stays
-- a row count and the dashboard does not have to filter zeroes. That needs a
-- DELETE privilege the app role has never held — and, because the permissive
-- user_belongs_to_org policy on inventory_deficits is FOR ALL (covering DELETE)
-- while 0013 gated only INSERT and UPDATE, a bare grant would let ANY member
-- erase deficits. The grant therefore ships with its own RESTRICTIVE gate, the
-- same pairing 0014 established for bill_of_materials.
--
-- Depends on: 0007 (post_stocktake + locks), 0013 (deficits), 0010 (role predicates)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The privilege needed to clear a settled deficit, gated to the same role
--    that may post a stocktake.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT DELETE ON public.inventory_deficits TO mosaiz_app_user;
    END IF;
END;
$$;

CREATE POLICY require_admin_delete ON public.inventory_deficits
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

-- ----------------------------------------------------------------------------
-- 2. post_stocktake — replaced from its current (0013) body. The status guard,
--    the advisory locks, their ordering, and the positive-variance true-up are
--    unchanged; what changes is that a shortfall now moves the stock.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.post_stocktake(p_stocktake_id uuid)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org    uuid;
    v_status text;
    v_item   record;
    v_batch  record;
    v_short  numeric;
    v_take   numeric;
BEGIN
    SELECT organization_id, status INTO v_org, v_status
    FROM public.stocktakes
    WHERE id = p_stocktake_id;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'stocktake % not found', p_stocktake_id;
    END IF;
    IF v_status <> 'draft' THEN
        RAISE EXCEPTION 'stocktake % is %; only a draft stocktake can be posted',
            p_stocktake_id, v_status;
    END IF;

    -- Lock every counted item's raw stock, in a deterministic order, for the
    -- rest of this transaction. A concurrent sale on the same ingredient blocks
    -- here and proceeds against the reconciled balances.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || raw_item_id::text))
    FROM public.stocktake_items
    WHERE stocktake_id = p_stocktake_id
    ORDER BY raw_item_id;

    UPDATE public.stocktakes SET status = 'posted' WHERE id = p_stocktake_id;

    -- The count settles every item it covers, whatever the variance.
    DELETE FROM public.inventory_deficits d
    WHERE d.organization_id = v_org
      AND d.raw_item_id IN (
          SELECT si.raw_item_id FROM public.stocktake_items si
          WHERE si.stocktake_id = p_stocktake_id
      );

    FOR v_item IN
        SELECT raw_item_id, variance
        FROM public.stocktake_items
        WHERE stocktake_id = p_stocktake_id
          AND variance <> 0
        ORDER BY raw_item_id
    LOOP
        IF v_item.variance > 0 THEN
            -- Found stock: true up the ledger with an adjustment lot. Found
            -- stock has no purchase cost, hence cost_at_purchase 0.
            INSERT INTO public.inventory_batches
                (organization_id, raw_item_id, quantity_received,
                 quantity_remaining, cost_at_purchase, expiry_date, received_at)
            VALUES (v_org, v_item.raw_item_id, v_item.variance,
                    v_item.variance, 0, NULL, now());
        ELSE
            -- Missing stock: draw the lots down so the books match the shelf.
            v_short := -v_item.variance;

            FOR v_batch IN
                SELECT id, quantity_remaining
                FROM public.inventory_batches
                WHERE raw_item_id = v_item.raw_item_id
                  AND organization_id = v_org
                  AND quantity_remaining > 0
                ORDER BY expiry_date ASC NULLS LAST, received_at ASC
                FOR UPDATE
            LOOP
                EXIT WHEN v_short <= 0;

                v_take := LEAST(v_batch.quantity_remaining, v_short);

                UPDATE public.inventory_batches
                SET quantity_remaining = quantity_remaining - v_take
                WHERE id = v_batch.id;

                v_short := v_short - v_take;
            END LOOP;

            IF v_short > 0 THEN
                -- The books claimed stock that no lot holds. Only this residue
                -- is a genuine deficit.
                INSERT INTO public.inventory_deficits
                    (organization_id, raw_item_id, missing_quantity)
                VALUES (v_org, v_item.raw_item_id, v_short)
                ON CONFLICT (organization_id, raw_item_id) DO UPDATE
                    SET missing_quantity =
                        public.inventory_deficits.missing_quantity + excluded.missing_quantity;

                RAISE NOTICE 'stocktake shortfall beyond recorded lots: item % short by %',
                    v_item.raw_item_id, v_short;
            END IF;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON PROCEDURE app.post_stocktake(uuid) IS
    'Posts a draft stocktake so the books match the count: surplus adds a true-up lot, shortfall draws lots down FIFO, and any deficit for the counted items is cleared because the count reconciles it (0019). Only a shortfall exceeding all recorded lots survives as a deficit.';

COMMIT;
