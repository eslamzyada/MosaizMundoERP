-- ============================================================================
-- Verification: does the drawer balance? (0047)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization   f10c0001 waiter   f10c0004 owner
--
-- The variance is the point, and a variance is only worth anything if the
-- expected side of it is real arithmetic over real rows. So most of these are
-- about what must NOT be counted:
--
--   1. Card money never entered the drawer. Counting it invents a shortfall
--      the size of the day's card takings.
--   2. A voided sale's cash went back out.
--   3. Money taken before the till was opened belongs to no cash-up — not to
--      the next one, which would move it into a shift it never happened in.
--   4. The float is part of expected, and forgetting it makes every drawer
--      look over by exactly the float.
--
-- And two about the shape:
--
--   5. One drawer at a time, and closing freezes the number.
--   6. Nobody can edit a variance into agreement afterwards.
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

-- A settled bill of a known size, paid however the caller says.
CREATE OR REPLACE FUNCTION pg_temp.sell(p_qty integer, p_method text)
RETURNS TABLE (order_id uuid, total numeric)
LANGUAGE plpgsql
AS $$
DECLARE
    v_order uuid;
    v_dish  uuid;
    v_total numeric;
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

    SELECT total_amount INTO v_total FROM public.orders WHERE id = v_order;

    PERFORM app.settle_order(v_order, jsonb_build_array(
        jsonb_build_object('method', p_method, 'amount', v_total)));

    RETURN QUERY SELECT v_order, v_total;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. Money taken with NO till open belongs to no cash-up.
--
--    Done first, deliberately: this sale must not appear in the session
--    opened immediately afterwards. Attributing it to the next session would
--    move money into a shift it did not happen in, which is exactly the
--    accusation a cash-up exists to avoid making.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_total numeric;
BEGIN
    -- Nothing may be open, or this proves nothing at all.
    IF EXISTS (SELECT FROM public.till_sessions
                WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                  AND closed_at IS NULL) THEN
        RAISE EXCEPTION 'a till is already open; this check needs none';
    END IF;

    SELECT order_id, total INTO v_order, v_total FROM pg_temp.sell(1, 'cash');

    -- Asserted against THIS sale's own payment, not against anything taken in
    -- the last few seconds: a time window catches other runs' rows and makes
    -- the check depend on how recently the suite last ran.
    IF EXISTS (
        SELECT FROM public.order_payments p
         WHERE p.order_id = v_order
           AND p.till_session_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'money taken with no open till was attributed to a session';
    END IF;

    -- And it really was recorded — otherwise "no session" would be true of a
    -- payment that does not exist.
    IF NOT EXISTS (SELECT FROM public.order_payments WHERE order_id = v_order) THEN
        RAISE EXCEPTION 'the sale recorded no payment at all';
    END IF;

    RAISE NOTICE 'OK 1: money taken before opening belongs to no cash-up';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. The arithmetic. Float, plus cash, and NOTHING else.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_session  uuid;
    v_cash     numeric;
    v_card     numeric;
    v_row      record;
BEGIN
    v_session := app.open_till_session('f10c0000-0000-4000-8000-000000000000', 200.00);

    SELECT total INTO v_cash FROM pg_temp.sell(1, 'cash');
    SELECT total INTO v_card FROM pg_temp.sell(2, 'card');   -- never enters the drawer

    -- Counted exactly right: float + cash.
    PERFORM app.close_till_session(
        'f10c0000-0000-4000-8000-000000000000', 200.00 + v_cash);

    SELECT * INTO v_row FROM public.till_sessions WHERE id = v_session;

    IF v_row.expected_cash <> ROUND(200.00 + v_cash, 2) THEN
        RAISE EXCEPTION 'expected was % but float+cash is %',
            v_row.expected_cash, ROUND(200.00 + v_cash, 2);
    END IF;
    IF v_row.variance <> 0 THEN
        RAISE EXCEPTION 'a drawer counted exactly right reported a variance of %',
            v_row.variance;
    END IF;

    -- THE ONE THAT MATTERS. If card money were counted, expected would be
    -- higher by v_card and the drawer would look short by exactly that.
    IF v_row.expected_cash >= ROUND(200.00 + v_cash + v_card, 2) THEN
        RAISE EXCEPTION 'card takings were counted as cash in the drawer';
    END IF;

    RAISE NOTICE 'OK 2: expected is float plus CASH, and card is not cash';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A real variance, in both directions.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_session uuid;
    v_cash    numeric;
    v_var     numeric;
BEGIN
    v_session := app.open_till_session('f10c0000-0000-4000-8000-000000000000', 100.00);
    SELECT total INTO v_cash FROM pg_temp.sell(1, 'cash');

    -- Ten short.
    PERFORM app.close_till_session(
        'f10c0000-0000-4000-8000-000000000000', 100.00 + v_cash - 10);

    SELECT variance INTO v_var FROM public.till_sessions WHERE id = v_session;
    IF v_var <> -10 THEN
        RAISE EXCEPTION 'a drawer ten short reported a variance of %', v_var;
    END IF;

    -- And over, which is not "fine" — it usually means a sale went unrecorded.
    v_session := app.open_till_session('f10c0000-0000-4000-8000-000000000000', 100.00);
    SELECT total INTO v_cash FROM pg_temp.sell(1, 'cash');
    PERFORM app.close_till_session(
        'f10c0000-0000-4000-8000-000000000000', 100.00 + v_cash + 25);

    SELECT variance INTO v_var FROM public.till_sessions WHERE id = v_session;
    IF v_var <> 25 THEN
        RAISE EXCEPTION 'a drawer twenty-five over reported a variance of %', v_var;
    END IF;

    RAISE NOTICE 'OK 3: short is negative, over is positive, both are real';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. The float is part of it.
--
--    Forgetting it makes every drawer look over by exactly the float, every
--    day, which reads as a systematic problem and is a missing addition.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_session uuid;
    v_row     record;
BEGIN
    v_session := app.open_till_session('f10c0000-0000-4000-8000-000000000000', 150.00);
    -- No sales at all: expected is the float and nothing else.
    PERFORM app.close_till_session('f10c0000-0000-4000-8000-000000000000', 150.00);

    SELECT * INTO v_row FROM public.till_sessions WHERE id = v_session;

    IF v_row.expected_cash <> 150.00 THEN
        RAISE EXCEPTION 'a till with no sales expected % rather than its float', v_row.expected_cash;
    END IF;
    IF v_row.variance <> 0 THEN
        RAISE EXCEPTION 'a quiet night with the float intact reported a variance';
    END IF;

    RAISE NOTICE 'OK 4: the opening float counts toward what should be there';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A voided sale's cash went back out of the drawer.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_session uuid;
    v_order   uuid;
    v_dish    uuid;
    v_total   numeric;
    v_row     record;
BEGIN
    v_session := app.open_till_session('f10c0000-0000-4000-8000-000000000000', 0);

    SELECT id INTO v_dish FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND is_active LIMIT 1;

    v_order := app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', gen_random_uuid()));
    PERFORM app.add_order_items(v_order, jsonb_build_array(
        jsonb_build_object('sellable_item_id', v_dish, 'quantity', 1)));
    PERFORM app.fire_order(v_order);
    SELECT total_amount INTO v_total FROM public.orders WHERE id = v_order;
    PERFORM app.settle_order(v_order, jsonb_build_array(
        jsonb_build_object('method', 'cash', 'amount', v_total)));

    -- Voiding is a manager's job (0022), and taking money is not — so the
    -- identity moves for exactly one statement and comes straight back. A
    -- suite that ran the whole thing as an owner would be testing a shape no
    -- restaurant has.
    PERFORM set_config('app.current_user_id',
                       'f10c0004-0000-4000-8000-000000000004', false);
    CALL app.void_order(v_order, true, 'test_order', NULL);
    PERFORM set_config('app.current_user_id',
                       'f10c0001-0000-4000-8000-000000000001', false);

    -- Counted: nothing. The money went back to the customer.
    PERFORM app.close_till_session('f10c0000-0000-4000-8000-000000000000', 0);

    SELECT * INTO v_row FROM public.till_sessions WHERE id = v_session;

    IF v_row.expected_cash <> 0 THEN
        RAISE EXCEPTION 'a voided sale still counted % toward the drawer', v_row.expected_cash;
    END IF;
    IF v_row.variance <> 0 THEN
        RAISE EXCEPTION 'voiding a paid sale left a variance of %', v_row.variance;
    END IF;

    RAISE NOTICE 'OK 5: a voided sale takes its cash back out of expected';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. One drawer at a time, and it must be open to be closed.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    PERFORM app.open_till_session('f10c0000-0000-4000-8000-000000000000', 0);

    BEGIN
        PERFORM app.open_till_session('f10c0000-0000-4000-8000-000000000000', 0);
        RAISE EXCEPTION 'two drawers were opened at once';
    EXCEPTION
        WHEN object_not_in_prerequisite_state THEN NULL;
    END;

    PERFORM app.close_till_session('f10c0000-0000-4000-8000-000000000000', 0);

    BEGIN
        PERFORM app.close_till_session('f10c0000-0000-4000-8000-000000000000', 0);
        RAISE EXCEPTION 'a till that was not open was closed';
    EXCEPTION
        WHEN object_not_in_prerequisite_state THEN NULL;
    END;

    RAISE NOTICE 'OK 6: one drawer at a time, and only an open one closes';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. The number is FROZEN, and cannot be edited into agreement.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_session uuid;
    v_before  numeric;
    v_after   numeric;
BEGIN
    SELECT id, variance INTO v_session, v_before
      FROM public.till_sessions
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND variance <> 0
     ORDER BY closed_at DESC LIMIT 1;

    IF v_session IS NULL THEN
        RAISE EXCEPTION 'fixture: no closed session with a variance to try to edit';
    END IF;

    BEGIN
        UPDATE public.till_sessions SET variance = 0, counted_cash = expected_cash
         WHERE id = v_session;
        -- Zero rows is also a refusal, but say which: a missing GRANT and a
        -- policy that filters to nothing are not the same defence.
        IF FOUND THEN
            RAISE EXCEPTION 'a variance was edited into agreement';
        END IF;
    EXCEPTION
        WHEN insufficient_privilege THEN NULL;
    END;

    SELECT variance INTO v_after FROM public.till_sessions WHERE id = v_session;
    IF v_after IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION 'the variance moved after it was signed off';
    END IF;

    IF has_table_privilege('mosaiz_app_user', 'public.till_sessions', 'UPDATE')
       OR has_table_privilege('mosaiz_app_user', 'public.till_sessions', 'INSERT')
       OR has_table_privilege('mosaiz_app_user', 'public.till_sessions', 'DELETE') THEN
        RAISE EXCEPTION 'the app role holds a write privilege on till_sessions';
    END IF;

    RAISE NOTICE 'OK 7: a signed-off variance cannot be rewritten';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Somebody who was not counting is told — and only when there is something
--    to tell.
--
--    Counted BEFORE and AFTER this suite's own closes, not asserted as "an
--    alert exists somewhere": a database that has run this before already has
--    alerts in it, and an existence check would pass with the notification
--    switched off entirely.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_owner  text := 'f10c0004-0000-4000-8000-000000000004';
    v_till   text := 'f10c0001-0000-4000-8000-000000000001';
    v_cash   numeric;
    v_start  bigint;
    v_mid    bigint;
    v_end    bigint;
BEGIN
    -- Counted from a RECIPIENT'S inbox, and the same one each time.
    --
    -- notifications are scoped to your own rows, and notify_roles deliberately
    -- skips the actor — so counting from the cashier who did the counting
    -- reads an inbox this alert is never sent to, gets zero every time, and
    -- would fail whether the alert fired or not.
    PERFORM set_config('app.current_user_id', v_owner, false);
    SELECT count(*) INTO v_start FROM public.notifications
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND kind = 'till_variance';

    -- A drawer that is OUT, counted by the cashier.
    PERFORM set_config('app.current_user_id', v_till, false);
    PERFORM app.open_till_session('f10c0000-0000-4000-8000-000000000000', 50.00);
    SELECT total INTO v_cash FROM pg_temp.sell(1, 'cash');
    PERFORM app.close_till_session(
        'f10c0000-0000-4000-8000-000000000000', 50.00 + v_cash - 37);

    PERFORM set_config('app.current_user_id', v_owner, false);
    SELECT count(*) INTO v_mid FROM public.notifications
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND kind = 'till_variance';

    IF v_mid <= v_start THEN
        RAISE EXCEPTION 'nobody was told about a drawer that was 37 short';
    END IF;

    -- A drawer that BALANCES. No new alert: one that fires every night is
    -- noise, and noise stops being read, which is worse than not sending it.
    PERFORM set_config('app.current_user_id', v_till, false);
    PERFORM app.open_till_session('f10c0000-0000-4000-8000-000000000000', 50.00);
    SELECT total INTO v_cash FROM pg_temp.sell(1, 'cash');
    PERFORM app.close_till_session(
        'f10c0000-0000-4000-8000-000000000000', 50.00 + v_cash);

    PERFORM set_config('app.current_user_id', v_owner, false);
    SELECT count(*) INTO v_end FROM public.notifications
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND kind = 'till_variance';

    IF v_end <> v_mid THEN
        RAISE EXCEPTION 'a balanced drawer raised an alert too';
    END IF;

    RAISE NOTICE 'OK 8: a drawer that is out is reported, and a balanced one is not';
END;
$$;

\echo 'till_session_verification: all checks passed'
