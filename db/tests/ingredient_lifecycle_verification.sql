-- ============================================================================
-- Ingredient lifecycle verification (0024) — runs as mosaiz_app_user, switching
-- between the cogs fixture's CASHIER and BRANCH MANAGER identities.
--
-- Covers the two things a user could not previously do: remove an ingredient,
-- and correct a cost keyed in wrongly at receiving. Both are ordinary
-- corrections; both are destructive if done carelessly, which is what these
-- assertions pin down.
--
-- Relies on the state write_off_verification leaves behind:
--   patty  (…f00d-0001): 0 on hand, but referenced by batches, consumption,
--                        recipes, deficits and write-offs — the "has history"
--                        case that must NEVER be deletable
--   cheese (…f00d-0002): 93 on hand in one lot @0.50
--
-- Run order: immediately after write_off_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

-- ----------------------------------------------------------------------------
-- 1. An ingredient with NO history is genuinely deleted. A typo created by
--    mistake should not have to be archived forever.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id      uuid;
    v_deleted int;
    v_left    int;
BEGIN
    INSERT INTO public.raw_inventory_items (organization_id, name, unit_of_measure)
    VALUES ('c0570000-0000-4000-8000-000000000000', 'Lifecycle Typo', 'kg')
    RETURNING id INTO v_id;

    DELETE FROM public.raw_inventory_items WHERE id = v_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> 1 THEN
        RAISE EXCEPTION 'an unused ingredient must be deletable (deleted % rows)', v_deleted;
    END IF;

    SELECT count(*) INTO v_left FROM public.raw_inventory_items WHERE id = v_id;
    IF v_left <> 0 THEN
        RAISE EXCEPTION 'the ingredient is still there after a successful delete';
    END IF;

    -- A second pristine ingredient, left in place for section 4: the cashier
    -- must fail to delete something that nothing else is protecting, so that the
    -- only thing refusing them is the policy.
    INSERT INTO public.raw_inventory_items (organization_id, name, unit_of_measure)
    VALUES ('c0570000-0000-4000-8000-000000000000', 'Lifecycle Spare', 'kg');
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. An ingredient WITH history cannot be deleted, and the refusal comes from
--    referential integrity rather than from anything the application remembered
--    to check. Cascading here would erase recorded COGS and the consumption
--    ledger a recall depends on.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_left   int;
BEGIN
    BEGIN
        DELETE FROM public.raw_inventory_items
        WHERE id = 'c057f00d-0000-4000-8000-000000000001';
    EXCEPTION WHEN foreign_key_violation THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'HISTORY LOSS: an ingredient with stock and sales was deleted';
    END IF;

    SELECT count(*) INTO v_left FROM public.raw_inventory_items
    WHERE id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_left <> 1 THEN
        RAISE EXCEPTION 'the refused delete must leave the ingredient in place';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Archiving is what that ingredient gets instead: hidden from pickers, every
--    historical row it participates in untouched.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_active   boolean;
    v_batches  int;
    v_ledger   int;
    v_recipes  int;
BEGIN
    UPDATE public.raw_inventory_items SET is_active = false
    WHERE id = 'c057f00d-0000-4000-8000-000000000001';

    SELECT is_active INTO v_active FROM public.raw_inventory_items
    WHERE id = 'c057f00d-0000-4000-8000-000000000001';
    IF v_active IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'archiving must set is_active false, got %', v_active;
    END IF;

    SELECT count(*) INTO v_batches FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    SELECT count(*) INTO v_ledger FROM public.inventory_consumption
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';
    SELECT count(*) INTO v_recipes FROM public.bill_of_materials
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000001';

    IF v_batches = 0 OR v_ledger = 0 OR v_recipes = 0 THEN
        RAISE EXCEPTION 'archiving destroyed history: % lots, % ledger rows, % recipe lines',
            v_batches, v_ledger, v_recipes;
    END IF;

    -- Restore, so later suites see the fixture as they expect it.
    UPDATE public.raw_inventory_items SET is_active = true
    WHERE id = 'c057f00d-0000-4000-8000-000000000001';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A cashier may neither delete nor archive.
--
--    Note the SHAPE of the refusal: a RESTRICTIVE policy FILTERS the row rather
--    than raising, so the statement succeeds having affected nothing. Asserting
--    row counts rather than expecting an exception is the only way to catch
--    this — a test that waited for an error would pass against a policy that
--    had been removed entirely.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_spare   uuid;
    v_deleted int;
    v_updated int;
    v_active  boolean;
BEGIN
    -- A pristine ingredient, so nothing but the policy can stop the delete.
    SELECT id INTO v_spare FROM public.raw_inventory_items
    WHERE organization_id = 'c0570000-0000-4000-8000-000000000000'
      AND name = 'Lifecycle Spare';

    DELETE FROM public.raw_inventory_items WHERE id = v_spare;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> 0 THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier deleted an ingredient';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.raw_inventory_items WHERE id = v_spare) THEN
        RAISE EXCEPTION 'SECURITY HOLE: the ingredient is gone after a cashier delete';
    END IF;

    UPDATE public.raw_inventory_items SET is_active = false WHERE id = v_spare;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 0 THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier archived an ingredient';
    END IF;

    SELECT is_active INTO v_active FROM public.raw_inventory_items WHERE id = v_spare;
    IF v_active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'a cashier managed to change is_active';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A cashier may not correct a cost either — and this one DOES raise, because
--    the function checks explicitly. It has to: require_sell_update permits a
--    cashier to UPDATE inventory_batches (checkout decrements quantity_remaining
--    as one), so the table's own policies would have let this through.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_lot    uuid;
    v_cost   numeric;
BEGIN
    SELECT id, cost_at_purchase INTO v_lot, v_cost FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';

    BEGIN
        PERFORM app.correct_batch_cost(v_lot, 99.00);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier corrected a stock cost';
    END IF;

    IF (SELECT cost_at_purchase FROM public.inventory_batches WHERE id = v_lot)
       IS DISTINCT FROM v_cost THEN
        RAISE EXCEPTION 'the refused correction changed the cost anyway';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A manager corrects a mis-keyed cost — and RECORDED MARGIN DOES NOT MOVE.
--
--    This is the property that separates a correction from a falsification.
--    0015 captures cost_at_sale at the moment of the sale precisely so that a
--    later price change cannot rewrite what was already reported. If this
--    assertion ever fails, every historical profit figure has become editable.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_lot        uuid;
    v_old        numeric;
    v_returned   numeric;
    v_new        numeric;
    v_cogs_before numeric;
    v_cogs_after  numeric;
BEGIN
    SELECT id, cost_at_purchase INTO v_lot, v_old FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';

    SELECT COALESCE(sum(cost_at_sale), 0) INTO v_cogs_before FROM public.order_items;

    v_returned := app.correct_batch_cost(v_lot, 7.25);

    IF v_returned IS DISTINCT FROM v_old THEN
        RAISE EXCEPTION 'the correction must return the previous cost (expected %, got %)',
            v_old, v_returned;
    END IF;

    SELECT cost_at_purchase INTO v_new FROM public.inventory_batches WHERE id = v_lot;
    IF v_new IS DISTINCT FROM 7.25 THEN
        RAISE EXCEPTION 'the lot cost must be corrected to 7.25, got %', v_new;
    END IF;

    SELECT COALESCE(sum(cost_at_sale), 0) INTO v_cogs_after FROM public.order_items;
    IF v_cogs_after IS DISTINCT FROM v_cogs_before THEN
        RAISE EXCEPTION
            'HISTORY REWRITTEN: correcting a lot cost changed recorded COGS (% -> %)',
            v_cogs_before, v_cogs_after;
    END IF;

    -- Put it back, so any later suite sees the fixture unchanged.
    PERFORM app.correct_batch_cost(v_lot, v_old);
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. The correction refuses what it should: a negative cost, and another
--    tenant's lot (invisible under RLS, so "not found" rather than "forbidden").
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_lot    uuid;
    caught   text;
BEGIN
    SELECT id INTO v_lot FROM public.inventory_batches
    WHERE raw_item_id = 'c057f00d-0000-4000-8000-000000000002';

    caught := NULL;
    BEGIN
        PERFORM app.correct_batch_cost(v_lot, -1);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '22023' THEN
        RAISE EXCEPTION 'a negative cost must raise 22023, got %', COALESCE(caught, 'nothing');
    END IF;

    caught := NULL;
    BEGIN
        PERFORM app.correct_batch_cost('00000000-0000-4000-8000-0000000000ff', 5);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM 'P0002' THEN
        RAISE EXCEPTION 'an unknown lot must raise P0002, got %', COALESCE(caught, 'nothing');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Structural: the DELETE privilege must always travel with its RESTRICTIVE
--    gate. The permissive user_belongs_to_org policy is FOR ALL and therefore
--    covers DELETE, so dropping the gate would silently let every member of the
--    organization delete ingredients — the trap 0014 and 0019 both had to step
--    around. Asserted against the catalogue, so a future migration cannot undo
--    it quietly.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_gate int;
BEGIN
    IF has_table_privilege('mosaiz_app_user', 'public.raw_inventory_items', 'DELETE') THEN
        SELECT count(*) INTO v_gate
        FROM pg_catalog.pg_policy
        WHERE polrelid = 'public.raw_inventory_items'::regclass
          AND NOT polpermissive
          AND polcmd IN ('d', '*');
        IF v_gate = 0 THEN
            RAISE EXCEPTION
                'DELETE is granted on raw_inventory_items with no RESTRICTIVE gate; '
                'the FOR ALL permissive policy covers DELETE, so every member can '
                'now delete ingredients';
        END IF;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. Structural: NOTHING referencing an ingredient may cascade on delete.
--
--    Section 2 only proves the delete is refused, and it would keep passing if
--    ONE of the seven foreign keys were quietly switched to ON DELETE CASCADE —
--    the remaining six would still refuse, so the behaviour would not change
--    until the last of them flipped, at which point a single DELETE would take
--    recorded COGS, the consumption ledger and past stocktakes with it.
--
--    (Found by counterfactual: injecting exactly that change was NOT caught by
--    the assertions above, which is why this one exists.)
--
--    SET NULL is refused for the same reason: an orphaned ledger row that no
--    longer names its ingredient is history that can no longer be read.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(c.conrelid::regclass::text || ' (' || c.conname || ')', ', ')
      INTO v_bad
    FROM pg_catalog.pg_constraint c
    WHERE c.confrelid = 'public.raw_inventory_items'::regclass
      AND c.contype = 'f'
      AND c.confdeltype IN ('c', 'n');   -- CASCADE, SET NULL

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'HISTORY IS NO LONGER PROTECTED: % cascades or nulls when an '
            'ingredient is deleted. Deleting an ingredient must be refused '
            'outright while any history references it — archiving (is_active) '
            'is the supported way to retire one.', v_bad;
    END IF;
END;
$$;

SELECT 'ingredient_lifecycle_verification: all assertions passed' AS result;
