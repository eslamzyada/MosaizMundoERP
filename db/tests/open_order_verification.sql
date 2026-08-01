-- ============================================================================
-- Open order verification (0029) — the tab lifecycle, and the two things that
-- would be expensive to get wrong.
--
--   * AN OPEN TAB IS NOT A SALE. Every revenue figure filters status =
--     'completed', so an open order must never reach one. If it did, a
--     restaurant would see its takings inflated by every table still eating.
--
--   * STOCK MOVES AT FIRE, NOT AT SETTLE. The ingredients leave the shelf when
--     the kitchen cooks. Deducting at settle would make the fridge report
--     chicken that is already on a plate for the length of every meal.
--
-- Seeds its own ingredient and dish so the arithmetic is exact regardless of
-- what earlier suites left on the shelf.
--
-- Run order: after order_comment_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

-- Seeded by the MANAGER (creating menu items and stock is administrative),
-- then the tab itself is run by the CASHIER, which is who serves tables.
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
BEGIN
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES ('09e40000-0000-4000-8000-00000000000f',
            'c0570000-0000-4000-8000-000000000000', 'Tab Cheese', 'جرام');

    -- 1000 g at 0.20 — enough for ten portions, priced so every figure below is
    -- a round number.
    INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            '09e40000-0000-4000-8000-00000000000f', 1000, 1000, 0.20);

    -- The dish is seeded by cogs_fixture as postgres (0035 took the menu away
    -- from the application role). Guarded rather than inserted.
    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE id = '09e45e11-0000-4000-8000-00000000000f') THEN
        RAISE EXCEPTION 'menu fixture missing: Tab Pizza was not seeded';
    END IF;

    -- 100 g of cheese per pizza -> 20.00 of cheese per pizza.
    INSERT INTO public.bill_of_materials
        (organization_id, sellable_item_id, raw_item_id, quantity_required)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            '09e45e11-0000-4000-8000-00000000000f',
            '09e40000-0000-4000-8000-00000000000f', 100);
END;
$$;

SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

-- ----------------------------------------------------------------------------
-- 1. Opening a tab moves NO stock and creates no sale.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order  uuid;
    v_status text;
    v_stock  numeric;
    v_total  numeric;
    v_fired  int;
BEGIN
    v_order := app.open_order(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', '09e40dee-0000-4000-8000-000000000001',
        'note',              'طاولة ٧',
        'items', jsonb_build_array(
            jsonb_build_object(
                'sellable_item_id', '09e45e11-0000-4000-8000-00000000000f',
                'quantity', 2))));

    SELECT status, total_amount INTO v_status, v_total
    FROM public.orders WHERE id = v_order;

    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'a new tab must be open, got %', v_status;
    END IF;
    IF v_total IS DISTINCT FROM 200.00 THEN
        RAISE EXCEPTION 'the tab must total 2 x 100.00, got %', v_total;
    END IF;

    -- Nothing has been cooked, so nothing has left the shelf.
    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = '09e40000-0000-4000-8000-00000000000f';
    IF v_stock IS DISTINCT FROM 1000.000 THEN
        RAISE EXCEPTION
            'OPENING A TAB MOVED STOCK: expected 1000 g untouched, got %. Stock '
            'must move when food is fired, not when it is ordered', v_stock;
    END IF;

    SELECT count(*) INTO v_fired FROM public.order_items
    WHERE order_id = v_order AND fired_at IS NOT NULL;
    IF v_fired <> 0 THEN
        RAISE EXCEPTION 'no line should be fired yet, got %', v_fired;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. THE ASSERTION THIS FEATURE TURNS ON: an open tab is invisible to revenue.
--
--    Written the way the reports actually ask the question, so it fails if the
--    status vocabulary ever grows a state the reports do not exclude.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_revenue numeric;
    v_open    numeric;
BEGIN
    SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) INTO v_revenue
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status = 'completed'
      AND o.client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) INTO v_open
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    IF v_open <= 0 THEN
        RAISE EXCEPTION 'the tab should hold 200.00 of food, got %', v_open;
    END IF;
    IF v_revenue <> 0 THEN
        RAISE EXCEPTION
            'AN OPEN TAB WAS COUNTED AS REVENUE (%). Every table still eating '
            'would inflate the day''s takings', v_revenue;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A tab can be edited while it is open: add, and remove what is not cooked.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_line  uuid;
    v_total numeric;
    v_lines int;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    PERFORM app.add_order_items(v_order, jsonb_build_array(
        jsonb_build_object(
            'sellable_item_id', '09e45e11-0000-4000-8000-00000000000f',
            'quantity', 1, 'note', 'بدون زيتون')));

    SELECT total_amount INTO v_total FROM public.orders WHERE id = v_order;
    IF v_total IS DISTINCT FROM 300.00 THEN
        RAISE EXCEPTION 'adding a pizza must take the tab to 300.00, got %', v_total;
    END IF;

    -- Remove the line just added: it has not been cooked, so nothing is lost.
    SELECT id INTO v_line FROM public.order_items
    WHERE order_id = v_order AND note = 'بدون زيتون';
    PERFORM app.remove_order_item(v_line);

    SELECT total_amount INTO v_total FROM public.orders WHERE id = v_order;
    SELECT count(*) INTO v_lines FROM public.order_items WHERE order_id = v_order;
    IF v_total IS DISTINCT FROM 200.00 OR v_lines <> 1 THEN
        RAISE EXCEPTION 'removing the line must restore 200.00 / 1 line, got % / %',
            v_total, v_lines;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Firing is where stock moves and cost is captured.
--    2 pizzas x 100 g = 200 g at 0.20 = 40.00 of cheese.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_fired int;
    v_stock numeric;
    v_cost  numeric;
    v_ok    boolean;
    v_when  timestamptz;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    v_fired := app.fire_order(v_order);
    IF v_fired <> 1 THEN
        RAISE EXCEPTION 'one line should have been fired, got %', v_fired;
    END IF;

    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = '09e40000-0000-4000-8000-00000000000f';
    IF v_stock IS DISTINCT FROM 800.000 THEN
        RAISE EXCEPTION 'firing 2 pizzas must draw 200 g (expected 800 left, got %)', v_stock;
    END IF;

    SELECT cost_at_sale, cost_is_complete, fired_at
      INTO v_cost, v_ok, v_when
    FROM public.order_items WHERE order_id = v_order;

    IF v_cost IS DISTINCT FROM 40.00 THEN
        RAISE EXCEPTION 'the line must carry the cost captured at fire (40.00), got %', v_cost;
    END IF;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'the cost is fully known, so cost_is_complete must be true';
    END IF;
    IF v_when IS NULL THEN
        RAISE EXCEPTION 'a fired line must record when it was sent to the kitchen';
    END IF;

    -- Still not a sale: firing tells the kitchen, it does not take the money.
    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'open' THEN
        RAISE EXCEPTION 'firing must not settle the order';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A FIRED line cannot simply be removed.
--
--    The food exists — the ingredients are gone and somebody made it. Taking it
--    off the bill is a different act with different consequences, and that act
--    is voiding, which asks whether the food was made (0018). A quiet delete
--    here would destroy stock history and drop a line from a bill with nobody
--    answering for it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
    v_line   uuid;
    v_stock  numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';
    SELECT id INTO v_line FROM public.order_items WHERE order_id = v_order;

    BEGIN
        PERFORM app.remove_order_item(v_line);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'a line already sent to the kitchen must not be removable';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE id = v_line) THEN
        RAISE EXCEPTION 'the refused removal deleted the line anyway';
    END IF;

    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = '09e40000-0000-4000-8000-00000000000f';
    IF v_stock IS DISTINCT FROM 800.000 THEN
        RAISE EXCEPTION 'the refused removal moved stock (got %)', v_stock;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Firing twice is refused rather than silently doing nothing — a cashier who
--    presses "send" again should be told the kitchen already has it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
    v_stock  numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    BEGIN
        PERFORM app.fire_order(v_order);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'firing an order with nothing pending must be refused';
    END IF;

    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = '09e40000-0000-4000-8000-00000000000f';
    IF v_stock IS DISTINCT FROM 800.000 THEN
        RAISE EXCEPTION 'DOUBLE DEDUCTION: refiring drew stock again (got %)', v_stock;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Settling is refused while anything is unfired.
--
--    Those items were never cooked, so settling would either charge for food
--    that does not exist or silently drop it from the bill — and only the
--    person at the till knows which was meant.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
    v_line   uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    PERFORM app.add_order_items(v_order, jsonb_build_array(
        jsonb_build_object(
            'sellable_item_id', '09e45e11-0000-4000-8000-00000000000f',
            'quantity', 1)));

    BEGIN
        PERFORM app.settle_order(v_order);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'settling with an unsent item must be refused';
    END IF;

    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'open' THEN
        RAISE EXCEPTION 'the refused settle changed the status anyway';
    END IF;

    -- Take it back off: the customer changed their mind.
    SELECT id INTO v_line FROM public.order_items
    WHERE order_id = v_order AND fired_at IS NULL;
    PERFORM app.remove_order_item(v_line);
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Settling turns the tab into a sale — and only then does it become revenue.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order   uuid;
    v_total   numeric;
    v_revenue numeric;
    v_stock   numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    v_total := app.settle_order(v_order);
    IF v_total IS DISTINCT FROM 200.00 THEN
        RAISE EXCEPTION 'settling must return the bill total 200.00, got %', v_total;
    END IF;

    SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) INTO v_revenue
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status = 'completed' AND o.id = v_order;
    IF v_revenue IS DISTINCT FROM 200.00 THEN
        RAISE EXCEPTION 'a settled tab must be revenue, got %', v_revenue;
    END IF;

    -- Settling takes money, not ingredients: the stock moved when it was fired.
    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = '09e40000-0000-4000-8000-00000000000f';
    IF v_stock IS DISTINCT FROM 800.000 THEN
        RAISE EXCEPTION 'settling must not move stock again (got %)', v_stock;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. A settled order is finished: it cannot be added to, fired or re-settled.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    caught  text;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    caught := NULL;
    BEGIN
        PERFORM app.add_order_items(v_order, jsonb_build_array(
            jsonb_build_object(
                'sellable_item_id', '09e45e11-0000-4000-8000-00000000000f',
                'quantity', 1)));
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '55000' THEN
        RAISE EXCEPTION 'adding to a settled order must raise 55000, got %',
            COALESCE(caught, 'nothing');
    END IF;

    caught := NULL;
    BEGIN
        PERFORM app.settle_order(v_order);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '55000' THEN
        RAISE EXCEPTION 'settling twice must raise 55000, got %', COALESCE(caught, 'nothing');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. SECURITY DEFINER means RLS filters nothing, so the tenant boundary is the
--     explicit check inside. Another organization's order must be "not found" —
--     not "forbidden", which would confirm the id exists.
--
--     The foreign id is a LITERAL from cross_tenant_fixture, not a lookup. RLS
--     hides other tenants' orders from this role completely, so a SELECT would
--     return nothing and this section would skip itself and report a pass — it
--     did precisely that until the fixture seeded a real row. That the row
--     exists is asserted in the fixture, which is the only place with the
--     visibility to assert it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_foreign  CONSTANT uuid := '0d4e4000-000f-400f-800f-00000000000f';
    v_nonesuch CONSTANT uuid := '0d4e4000-000f-400f-800f-0000000000aa';
    caught     text;
    caught_msg text;
    other      text;
BEGIN
    caught := NULL;
    BEGIN
        PERFORM app.fire_order(v_foreign);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE; caught_msg := SQLERRM;
    END;
    IF caught IS DISTINCT FROM 'P0002' THEN
        RAISE EXCEPTION
            'CROSS-TENANT LEAK: firing another organization''s order raised % '
            '(expected P0002 not-found; DEFINER means only the explicit check '
            'stands between tenants)', COALESCE(caught, 'nothing');
    END IF;

    -- An id that exists elsewhere and an id that exists nowhere must be
    -- indistinguishable, or the error itself confirms which orders are real.
    other := NULL;
    BEGIN
        PERFORM app.fire_order(v_nonesuch);
    EXCEPTION WHEN OTHERS THEN other := SQLERRM;
    END;
    IF other IS NULL THEN
        RAISE EXCEPTION 'firing an order that does not exist must be refused';
    END IF;
    IF replace(other, v_nonesuch::text, '') <> replace(caught_msg, v_foreign::text, '') THEN
        RAISE EXCEPTION
            'ORDER IDS ARE PROBEABLE: another tenant''s order answers "%" while '
            'a nonexistent one answers "%"', caught_msg, other;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. An accountant is read-only and may not serve tables.
--
--     The refusal must be 42501 SPECIFICALLY. P0002 would mean this user is not
--     a member of the organization at all — refused for belonging nowhere,
--     which proves nothing about roles. Accepting P0002 here is exactly how
--     this section passed while asserting nothing: the accountant it named did
--     not exist until cogs_fixture seeded one.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570003-0000-4000-8000-000000000003';

DO $$
DECLARE
    caught text;
BEGIN
    IF NOT app.user_belongs_to_org('c0570000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION
            'the accountant is not a member of this organization, so every '
            'refusal below would be about membership rather than role';
    END IF;

    caught := NULL;
    BEGIN
        PERFORM app.open_order(jsonb_build_object(
            'organization_id',   'c0570000-0000-4000-8000-000000000000',
            'client_offline_id', '09e40dee-0000-4000-8000-0000000000ff',
            'items', jsonb_build_array(
                jsonb_build_object(
                    'sellable_item_id', '09e45e11-0000-4000-8000-00000000000f',
                    'quantity', 1))));
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;

    IF caught IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION
            'an accountant must be refused a tab with 42501, got %',
            COALESCE(caught, 'no error at all');
    END IF;

    -- And again with NO items. That case matters on its own: with items, the
    -- refusal can come from add_order_items' check rather than open_order's, so
    -- open_order could lose its own gate and this section would still pass. A
    -- table is seated before it orders, so an empty tab is a real request.
    caught := NULL;
    BEGIN
        PERFORM app.open_order(jsonb_build_object(
            'organization_id',   'c0570000-0000-4000-8000-000000000000',
            'client_offline_id', '09e40dee-0000-4000-8000-0000000000fe'));
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;

    IF caught IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION
            'an accountant opened an EMPTY tab (got %): open_order is relying '
            'on add_order_items to refuse and refuses nothing itself',
            COALESCE(caught, 'no error at all');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. An unfired line cannot claim a cost.
--
--     Without this guard a line could sit at cost_is_complete = true having
--     consumed nothing, and the margin report would count a dish nobody has
--     cooked. Asserted directly, because no procedure would produce that state
--     and so nothing else here would notice if the constraint disappeared.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    rejected boolean := false;
    v_order  uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000001';

    BEGIN
        INSERT INTO public.order_items
            (order_id, organization_id, sellable_item_id, quantity, unit_price,
             cost_at_sale, cost_is_complete, fired_at)
        VALUES (v_order, 'c0570000-0000-4000-8000-000000000000',
                '09e45e11-0000-4000-8000-00000000000f', 1, 100, 40.00, true, NULL);
    EXCEPTION WHEN check_violation THEN
        rejected := true;
    END;

    IF NOT rejected THEN
        RAISE EXCEPTION
            'an UNFIRED line was allowed to carry a cost; the margin report '
            'would count food nobody has cooked';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 13. An open tab can be CANCELLED (0030), and gives back only what was cooked.
--
--     A table that walks out, or a tab opened by mistake, has to be closable.
--     Before 0030 app.void_order matched no row for an open order and reported
--     'voiding an order is limited to managers' — to a manager.
--
--     The stock arithmetic is the point: the fired line took real ingredients
--     and gives them back, the unfired line never took any and conjures none.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_order uuid;
    v_stock numeric;
BEGIN
    v_order := app.open_order(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', '09e40dee-0000-4000-8000-000000000002',
        'note',              'طاولة ٩ — غادروا',
        'items', jsonb_build_array(
            jsonb_build_object(
                'sellable_item_id', '09e45e11-0000-4000-8000-00000000000f',
                'quantity', 1))));

    PERFORM app.fire_order(v_order);

    -- 100 g cooked, so 800 - 100 = 700.
    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = '09e40000-0000-4000-8000-00000000000f';
    IF v_stock IS DISTINCT FROM 700.000 THEN
        RAISE EXCEPTION 'firing one pizza must leave 700 g, got %', v_stock;
    END IF;

    -- A second course, ordered but never sent to the kitchen.
    PERFORM app.add_order_items(v_order, jsonb_build_array(
        jsonb_build_object(
            'sellable_item_id', '09e45e11-0000-4000-8000-00000000000f',
            'quantity', 1)));
END;
$$;

-- A cashier still may not void: 0030 widened WHICH orders can be voided, not
-- who may void them.
DO $$
DECLARE
    caught text;
    v_order uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000002';

    caught := NULL;
    BEGIN
        CALL app.void_order(v_order, true, 'customer_cancelled', NULL);
    EXCEPTION WHEN OTHERS THEN caught := SQLSTATE;
    END;
    IF caught IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION
            'a cashier voided an open tab (got %); widening the status must not '
            'widen the role', COALESCE(caught, 'no error at all');
    END IF;
    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'open' THEN
        RAISE EXCEPTION 'the refused void changed the status anyway';
    END IF;
END;
$$;

SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_order   uuid;
    v_stock   numeric;
    v_status  text;
    v_revenue numeric;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = '09e40dee-0000-4000-8000-000000000002';

    CALL app.void_order(v_order, true, 'customer_cancelled', 'غادروا قبل التقديم');

    SELECT status INTO v_status FROM public.orders WHERE id = v_order;
    IF v_status <> 'voided' THEN
        RAISE EXCEPTION 'a manager must be able to cancel an open tab, status is %', v_status;
    END IF;

    -- Back to 800: the fired line's 100 g returns, the unfired line's does not,
    -- because it never left.
    SELECT sum(quantity_remaining) INTO v_stock FROM public.inventory_batches
    WHERE raw_item_id = '09e40000-0000-4000-8000-00000000000f';
    IF v_stock IS DISTINCT FROM 800.000 THEN
        RAISE EXCEPTION
            'cancelling must give back the 100 g that was cooked and nothing '
            'more (expected 800, got %)', v_stock;
    END IF;

    SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) INTO v_revenue
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status = 'completed' AND o.id = v_order;
    IF v_revenue <> 0 THEN
        RAISE EXCEPTION 'a cancelled tab must not be revenue, got %', v_revenue;
    END IF;
END;
$$;

SELECT 'open_order_verification: all assertions passed' AS result;
