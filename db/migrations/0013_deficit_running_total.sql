-- ============================================================================
-- Migration 0013: Inventory deficits as a running total (fixes F-14)
-- Mosaiz Mundo ERP
--
-- inventory_deficits was an append-only ledger: every short sale INSERTed a new
-- row, so an ingredient sold-while-out accrued one row per sale and the table
-- grew without bound (the dashboard then loaded them all). The operational
-- question is "how much am I short right now", not "list every shortfall
-- event", so this collapses the table to ONE running total per (org, raw item).
--
-- What changes:
--   * Existing rows are summed into one row per (organization_id, raw_item_id).
--   * A UNIQUE (organization_id, raw_item_id) constraint makes that the model.
--   * The two procedures that record a shortfall — process_inventory_deduction
--     (a sale) and post_stocktake (a count) — now UPSERT: the shortfall is
--     ADDED to the existing total instead of inserting a new row. Both are
--     replaced from their CURRENT (0007) bodies, changing ONLY the deficit
--     write; the advisory locks, FIFO order, and true-up logic are untouched.
--   * The upsert's UPDATE branch needs the app role to hold UPDATE on the table
--     (it only had INSERT), gated — like the INSERT (0010) — to sell-capable
--     roles via a RESTRICTIVE policy, so an accountant still cannot mutate it.
--
-- Depends on: 0006/0007 (deficits + the two procedures), 0010 (role predicates)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Collapse the historical ledger into a running total. Runs as the migration
--    owner, which bypasses RLS, so it sees and rewrites every tenant's rows.
--    On a fresh database (CI) this is a no-op over zero rows.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE _deficit_rollup ON COMMIT DROP AS
    SELECT organization_id,
           raw_item_id,
           sum(missing_quantity) AS missing_quantity,
           min(recorded_at)      AS recorded_at
    FROM public.inventory_deficits
    GROUP BY organization_id, raw_item_id;

DELETE FROM public.inventory_deficits;

INSERT INTO public.inventory_deficits
    (organization_id, raw_item_id, missing_quantity, recorded_at)
SELECT organization_id, raw_item_id, missing_quantity, recorded_at
FROM _deficit_rollup;

-- The plain index is now redundant with the unique constraint's own index.
DROP INDEX IF EXISTS public.inventory_deficits_org_item_idx;

ALTER TABLE public.inventory_deficits
    ADD CONSTRAINT inventory_deficits_org_item_key
    UNIQUE (organization_id, raw_item_id);

COMMENT ON TABLE public.inventory_deficits IS
    'Running total of stock sold beyond recorded supply, one row per (org, raw item), awaiting reconciliation. Accumulated by process_inventory_deduction and post_stocktake via UPSERT (0013).';

-- ----------------------------------------------------------------------------
-- 2. Grant + policy for the upsert's UPDATE branch. The app role held only
--    SELECT/INSERT; ON CONFLICT DO UPDATE needs UPDATE. Gate it to sell-capable
--    roles, mirroring require_sell_insert from 0010, so the accumulation follows
--    the same authorization as the original record.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT UPDATE ON public.inventory_deficits TO mosaiz_app_user;
    END IF;
END;
$$;

CREATE POLICY require_sell_update ON public.inventory_deficits
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_sell(organization_id))
    WITH CHECK (app.user_can_sell(organization_id));

-- ----------------------------------------------------------------------------
-- 3. process_inventory_deduction — replaced from its current (0007) body, with
--    the deficit INSERT changed to an UPSERT. Everything else is identical.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.process_inventory_deduction(
    p_raw_item_id        uuid,
    p_organization_id    uuid,
    p_quantity_to_deduct numeric
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_remaining numeric := p_quantity_to_deduct;
    v_take      numeric;
    v_batch     record;
BEGIN
    IF p_quantity_to_deduct IS NULL OR p_quantity_to_deduct <= 0 THEN
        RAISE EXCEPTION 'quantity_to_deduct must be positive (got %)', p_quantity_to_deduct;
    END IF;

    -- Serialize with stocktake postings on this exact raw item.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || p_raw_item_id::text));

    FOR v_batch IN
        SELECT id, quantity_remaining
        FROM public.inventory_batches
        WHERE raw_item_id = p_raw_item_id
          AND organization_id = p_organization_id
          AND quantity_remaining > 0
        ORDER BY expiry_date ASC NULLS LAST, received_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;

        v_take := LEAST(v_batch.quantity_remaining, v_remaining);

        UPDATE public.inventory_batches
        SET quantity_remaining = quantity_remaining - v_take
        WHERE id = v_batch.id;

        v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining > 0 THEN
        -- Accumulate onto the item's running deficit total (0013), never a new row.
        INSERT INTO public.inventory_deficits
            (organization_id, raw_item_id, missing_quantity)
        VALUES (p_organization_id, p_raw_item_id, v_remaining)
        ON CONFLICT (organization_id, raw_item_id) DO UPDATE
            SET missing_quantity =
                public.inventory_deficits.missing_quantity + excluded.missing_quantity;

        RAISE NOTICE 'inventory deficit recorded: item % short by % unit(s)',
            p_raw_item_id, v_remaining;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. post_stocktake — replaced from its current (0007) body, with the deficit
--    INSERT changed to an UPSERT. The found-stock true-up lot is unchanged.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.post_stocktake(p_stocktake_id uuid)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org    uuid;
    v_status text;
    v_item   record;
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
    -- rest of this transaction.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || raw_item_id::text))
    FROM public.stocktake_items
    WHERE stocktake_id = p_stocktake_id
    ORDER BY raw_item_id;

    UPDATE public.stocktakes SET status = 'posted' WHERE id = p_stocktake_id;

    FOR v_item IN
        SELECT raw_item_id, variance
        FROM public.stocktake_items
        WHERE stocktake_id = p_stocktake_id
          AND variance <> 0
    LOOP
        IF v_item.variance < 0 THEN
            -- Missing stock: accumulate onto the running deficit total (0013).
            INSERT INTO public.inventory_deficits
                (organization_id, raw_item_id, missing_quantity)
            VALUES (v_org, v_item.raw_item_id, -v_item.variance)
            ON CONFLICT (organization_id, raw_item_id) DO UPDATE
                SET missing_quantity =
                    public.inventory_deficits.missing_quantity + excluded.missing_quantity;
        ELSE
            -- Found stock: true up the ledger with an adjustment lot. Found
            -- stock has no purchase cost, hence cost_at_purchase 0.
            INSERT INTO public.inventory_batches
                (organization_id, raw_item_id, quantity_received,
                 quantity_remaining, cost_at_purchase, expiry_date, received_at)
            VALUES (v_org, v_item.raw_item_id, v_item.variance,
                    v_item.variance, 0, NULL, now());
        END IF;
    END LOOP;
END;
$$;

COMMIT;
