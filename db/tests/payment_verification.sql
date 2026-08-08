-- ============================================================================
-- Verification: how the bill was paid (0046)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization   f10c0001 waiter   f10c0004 owner
--
-- The claim this whole file defends is one sentence:
--
--     UNSPECIFIED IS NOT CASH.
--
-- Everything settled before 0046 has no payment rows, and every till that has
-- not been updated will keep settling without them. Defaulting those to cash
-- would give every report a tidy number and make the nightly cash-up a
-- fiction — and a fiction somebody acts on, by accusing a cashier of being
-- short. So the absence has to survive, visibly, all the way through.
--
-- The rest:
--
--   1. A settled bill's payments equal the bill. Otherwise the table is
--      decoration and reconciles nothing.
--   2. Splitting is ordinary and must add up across rows, not per row.
--   3. A refused tender does not settle the order. Taking the money is part
--      of settling, not something that happens afterwards.
--   4. A till cannot write a payment for a bill it did not settle.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

-- A tab, run up to a known total, ready to settle. Wrapped so each check below
-- gets a fresh one without repeating the lifecycle.
CREATE OR REPLACE FUNCTION pg_temp.a_tab_worth(p_qty integer)
RETURNS TABLE (order_id uuid, total numeric)
LANGUAGE plpgsql
AS $$
DECLARE
    v_order uuid;
    v_dish  uuid;
BEGIN
    SELECT id INTO v_dish FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND is_active LIMIT 1;

    v_order := app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', gen_random_uuid()));

    PERFORM app.add_order_items(v_order, jsonb_build_array(
        jsonb_build_object('sellable_item_id', v_dish, 'quantity', p_qty)));
    PERFORM app.fire_order(v_order);

    RETURN QUERY
        SELECT v_order, o.total_amount FROM public.orders o WHERE o.id = v_order;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. THE ONE THAT MATTERS. A tab settled with no tender is UNSPECIFIED.
--
--    Not cash. Not zero. No rows at all, and the absence is the answer.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
BEGIN
    SELECT order_id, total INTO v_order, v_total FROM pg_temp.a_tab_worth(1);

    PERFORM app.settle_order(v_order);

    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'completed' THEN
        RAISE EXCEPTION 'a tab could not be settled without naming a tender';
    END IF;

    IF EXISTS (SELECT FROM public.order_payments WHERE order_id = v_order) THEN
        RAISE EXCEPTION 'a payment was invented for a sale nobody described';
    END IF;

    RAISE NOTICE 'OK 1: settling without a tender records nothing, not cash';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A tender that is named is recorded, against the person who took it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
    v_row   record;
BEGIN
    SELECT order_id, total INTO v_order, v_total FROM pg_temp.a_tab_worth(1);

    PERFORM app.settle_order(v_order, jsonb_build_array(
        jsonb_build_object('method', 'card', 'amount', v_total)));

    SELECT * INTO v_row FROM public.order_payments WHERE order_id = v_order;

    IF v_row.method <> 'card' THEN
        RAISE EXCEPTION 'the method was not recorded: %', v_row.method;
    END IF;
    IF v_row.amount <> ROUND(v_total, 2) THEN
        RAISE EXCEPTION 'the amount was not recorded: %', v_row.amount;
    END IF;
    -- Who took the money. A money record with a fictional cashier on it would
    -- be worse than one that admits nobody was bound.
    IF v_row.received_by IS DISTINCT FROM 'f10c0001-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'the tender was not attributed to whoever took it';
    END IF;

    RAISE NOTICE 'OK 2: a named tender is recorded, and attributed';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Splitting a bill. Two rows, and they add up ACROSS rows — a per-row check
--    would refuse every split there is.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
    v_half  numeric;
    v_rest  numeric;
BEGIN
    SELECT order_id, total INTO v_order, v_total FROM pg_temp.a_tab_worth(2);

    v_half := ROUND(v_total / 2, 2);
    v_rest := ROUND(v_total, 2) - v_half;

    PERFORM app.settle_order(v_order, jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', v_half),
        jsonb_build_object('method', 'card', 'amount', v_rest)));

    IF (SELECT count(*) FROM public.order_payments WHERE order_id = v_order) <> 2 THEN
        RAISE EXCEPTION 'a split bill did not record two tenders';
    END IF;
    IF (SELECT SUM(amount) FROM public.order_payments WHERE order_id = v_order)
       <> ROUND(v_total, 2) THEN
        RAISE EXCEPTION 'the split does not add up to the bill';
    END IF;

    RAISE NOTICE 'OK 3: a bill splits across tenders and still adds up';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Money that does not add up refuses the SETTLE, not just the payment.
--
--    Taking the money is part of closing the bill. An implementation that
--    completed the order and then failed to write the tender would leave a
--    settled sale with no money against it and no way to notice.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
BEGIN
    SELECT order_id, total INTO v_order, v_total FROM pg_temp.a_tab_worth(1);

    BEGIN
        PERFORM app.settle_order(v_order, jsonb_build_array(
            jsonb_build_object('method', 'cash', 'amount', ROUND(v_total, 2) - 1)));
        RAISE EXCEPTION 'a bill settled for less than it was worth';
    EXCEPTION
        WHEN invalid_parameter_value THEN NULL;
    END;

    -- The order is STILL OPEN. This is the assertion; the refusal above is
    -- only half of it.
    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'open' THEN
        RAISE EXCEPTION 'the tab was closed despite the tender being refused';
    END IF;
    IF EXISTS (SELECT FROM public.order_payments WHERE order_id = v_order) THEN
        RAISE EXCEPTION 'a partial payment was recorded anyway';
    END IF;

    -- And it can still be settled properly afterwards, which is what a cashier
    -- would do next.
    PERFORM app.settle_order(v_order, jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', v_total)));

    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'completed' THEN
        RAISE EXCEPTION 'the corrected tender did not settle the tab';
    END IF;

    RAISE NOTICE 'OK 4: money that does not add up leaves the tab open';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4b. A negative tender is refused.
--
--     Without this a till could "pay" a bill with a positive card line and a
--     negative cash line that still sums to the total — and walk out with the
--     difference, having left a set of payments that reconcile perfectly.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
BEGIN
    SELECT order_id, total INTO v_order, v_total FROM pg_temp.a_tab_worth(2);

    BEGIN
        PERFORM app.settle_order(v_order, jsonb_build_array(
            jsonb_build_object('method', 'card', 'amount', ROUND(v_total, 2) + 50),
            jsonb_build_object('method', 'cash', 'amount', -50)));
        RAISE EXCEPTION 'a negative tender was accepted';
    EXCEPTION
        -- The CHECK constraint is what refuses it, so this arrives as 23514.
        WHEN check_violation THEN NULL;
        WHEN invalid_parameter_value THEN NULL;
    END;

    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'open' THEN
        RAISE EXCEPTION 'the tab closed on a tender containing a negative line';
    END IF;
    IF EXISTS (SELECT FROM public.order_payments WHERE order_id = v_order) THEN
        RAISE EXCEPTION 'part of a refused tender was recorded';
    END IF;

    RAISE NOTICE 'OK 4b: a negative line cannot hide inside a balanced tender';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A method nobody recognises is refused, rather than stored as itself.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
BEGIN
    SELECT order_id, total INTO v_order, v_total FROM pg_temp.a_tab_worth(1);

    BEGIN
        PERFORM app.settle_order(v_order, jsonb_build_array(
            jsonb_build_object('method', 'crypto', 'amount', v_total)));
        RAISE EXCEPTION 'an unknown payment method was accepted';
    EXCEPTION
        WHEN invalid_parameter_value THEN NULL;
    END;

    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'open' THEN
        RAISE EXCEPTION 'the tab closed on an unknown method';
    END IF;

    RAISE NOTICE 'OK 5: an unrecognised method is refused, and nothing closes';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A counter sale carries its tender too.
--
--    Half the money in a quick-service restaurant never touches a tab, so a
--    payment mix built from tabs alone would be confidently wrong rather than
--    visibly incomplete.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_coid  uuid := gen_random_uuid();
    v_dish  uuid;
    v_order uuid;
    v_price numeric;
BEGIN
    SELECT id, price INTO v_dish, v_price FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND is_active LIMIT 1;

    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', v_coid,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', v_dish, 'quantity', 1)),
        'payments', jsonb_build_array(
            jsonb_build_object('method', 'cash', 'amount', v_price))));

    SELECT id INTO v_order FROM public.orders WHERE client_offline_id = v_coid;

    IF (SELECT count(*) FROM public.order_payments WHERE order_id = v_order) <> 1 THEN
        RAISE EXCEPTION 'the counter sale recorded no tender';
    END IF;

    -- Idempotency reaches the money too. A till retrying a checkout whose
    -- answer it never saw must not record the cash twice — that is the one
    -- kind of duplicate nobody notices until the drawer is short.
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', v_coid,
        'items', jsonb_build_array(
            jsonb_build_object('sellable_item_id', v_dish, 'quantity', 1)),
        'payments', jsonb_build_array(
            jsonb_build_object('method', 'cash', 'amount', v_price))));

    IF (SELECT count(*) FROM public.order_payments WHERE order_id = v_order) <> 1 THEN
        RAISE EXCEPTION 'a retried checkout recorded the money twice';
    END IF;

    RAISE NOTICE 'OK 6: a counter sale records its tender, exactly once';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. A till cannot write money directly.
--
--    Asserted at the PRIVILEGE level as well as by attempting it: a missing
--    policy and a missing GRANT both raise 42501, and only one of them
--    survives somebody adding a permissive policy later.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000' LIMIT 1;

    BEGIN
        INSERT INTO public.order_payments (organization_id, order_id, method, amount)
        VALUES ('f10c0000-0000-4000-8000-000000000000', v_order, 'cash', 1);
        RAISE EXCEPTION 'the application role wrote a payment directly';
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    IF NOT has_table_privilege('mosaiz_app_user', 'public.order_payments', 'SELECT') THEN
        RAISE EXCEPTION 'the app role cannot read the money it took';
    END IF;
    IF has_table_privilege('mosaiz_app_user', 'public.order_payments', 'INSERT')
       OR has_table_privilege('mosaiz_app_user', 'public.order_payments', 'UPDATE')
       OR has_table_privilege('mosaiz_app_user', 'public.order_payments', 'DELETE') THEN
        RAISE EXCEPTION 'the app role holds a write privilege on order_payments';
    END IF;

    RAISE NOTICE 'OK 7: money is readable and not writable by the till';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. And it cannot write money against ANOTHER restaurant's bill.
--
--    record_payments is granted to the app role, because the counter-sale
--    procedure runs as the caller and could not reach it otherwise. That grant
--    is only safe because the function asks the same question serving an order
--    asks — so this is the test that keeps it safe.
--
--    Addressed by literal id from floor_roles_fixture. A lookup by
--    organization_id would find nothing under RLS and leave the attempt below
--    to be made with NULL, which proves nothing.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    -- The solo restaurant's order, by LITERAL id from floor_roles_fixture.
    --
    -- Not a lookup: that row belongs to another restaurant, so RLS hides it
    -- and the lookup finds nothing — leaving the attempt to be made against an
    -- id that does not exist, which even an implementation with no tenant
    -- check at all refuses. That is exactly how this check first passed while
    -- the guard it exists for was missing.
    v_foreign_order uuid := '0d0e0000-000f-400f-800f-00000000000f';
BEGIN
    BEGIN
        PERFORM app.record_payments(v_foreign_order,
            jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 1)), 1);
        RAISE EXCEPTION 'money was recorded against another restaurant''s bill';
    EXCEPTION
        WHEN no_data_found THEN NULL;
        WHEN insufficient_privilege THEN
            RAISE EXCEPTION 'refused as forbidden, which tells a prober the order exists';
    END;

    RAISE NOTICE 'OK 8: money cannot be written against a bill that is not ours';
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. A bill is paid ONCE.
--
--    record_payments is granted to the app role, so this is reachable
--    directly. Calling it twice would stack a second full tender onto a paid
--    bill — and the sum check passes each time, so the night's takings double
--    one retry at a time with nothing looking wrong.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
BEGIN
    SELECT order_id, total INTO v_order, v_total FROM pg_temp.a_tab_worth(1);

    PERFORM app.settle_order(v_order, jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', v_total)));

    BEGIN
        PERFORM app.record_payments(v_order,
            jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', v_total)),
            v_total);
        RAISE EXCEPTION 'the same bill was paid twice';
    EXCEPTION
        WHEN object_not_in_prerequisite_state THEN NULL;
    END;

    IF (SELECT count(*) FROM public.order_payments WHERE order_id = v_order) <> 1 THEN
        RAISE EXCEPTION 'a second tender was recorded against a paid bill';
    END IF;
    IF (SELECT SUM(amount) FROM public.order_payments WHERE order_id = v_order)
       <> ROUND(v_total, 2) THEN
        RAISE EXCEPTION 'the recorded money no longer matches the bill';
    END IF;

    RAISE NOTICE 'OK 9: a bill can only be paid once';
END;
$$;

\echo 'payment_verification: all checks passed'
