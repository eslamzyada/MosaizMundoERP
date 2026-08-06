-- ============================================================================
-- Verification: public ordering (0040)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--
-- This is the one place in the schema where a call arrives with NO identity
-- bound, so the assertions are about what an anonymous caller cannot do:
--
--   1. THE ONE THAT MATTERS: they cannot set a price. Lines are priced from
--      the menu, and a price sent by the client is not read at all.
--   2. They cannot name a tenant. Every entry point takes a slug; there is no
--      organization_id parameter to tamper with.
--   3. They cannot move stock. A request is a request until a human accepts it.
--   4. They cannot read anything. RLS still applies to every table; only three
--      SECURITY DEFINER functions are reachable, and they return what a
--      customer needs and nothing more.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'public_ordering', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- Setup: a dish, through the real approval cycle (0035 revoked direct writes
-- to the menu, so this is the only way one exists), and a shopfront.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
BEGIN
    INSERT INTO public.menu_change_requests
        (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'create', 'كشري أونلاين', 45.00,
            'صنف لاختبار الطلب أونلاين',
            'f10c0002-0000-4000-8000-000000000002');
END;
$$;

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_req uuid;
BEGIN
    SELECT id INTO v_req FROM public.menu_change_requests
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'pending' AND proposed_name = 'كشري أونلاين';
    PERFORM app.decide_menu_change(v_req, true, 'موافق');

    INSERT INTO public.storefronts (organization_id, slug, display_name, greeting, is_accepting)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'mosaiz-test',
            'مطعم الاختبار', 'أهلًا بك', true);

    RAISE NOTICE 'setup: menu item and shopfront ready';
END;
$$;

-- ----------------------------------------------------------------------------
-- From here on: NO IDENTITY. This is what an anonymous request looks like.
-- ----------------------------------------------------------------------------
RESET app.current_user_id;

-- ----------------------------------------------------------------------------
-- 1. An anonymous caller can read the menu, and NOTHING else.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_items int;
    v_rows  int;
BEGIN
    SELECT count(*) INTO v_items FROM app.public_menu('mosaiz-test');
    IF v_items = 0 THEN
        RAISE EXCEPTION 'the public menu is empty — the rest of this suite would be vacuous';
    END IF;

    -- Every table is still behind RLS with no identity bound.
    SELECT count(*) INTO v_rows FROM public.sellable_items;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'an anonymous caller can read the menu TABLE (% rows)', v_rows;
    END IF;
    SELECT count(*) INTO v_rows FROM public.orders;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'an anonymous caller can read orders (% rows)', v_rows;
    END IF;
    SELECT count(*) INTO v_rows FROM public.storefronts;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'an anonymous caller can read storefronts (% rows)', v_rows;
    END IF;

    RAISE NOTICE 'OK 1: % menu items through the function, 0 rows through any table', v_items;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. THE ONE THAT MATTERS: the customer cannot set a price.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_item   uuid;
    v_menu   numeric;
    v_token  uuid;
    v_quoted numeric;
    v_line   numeric;
BEGIN
    SELECT item_id, price INTO v_item, v_menu
      FROM app.public_menu('mosaiz-test') WHERE name = 'كشري أونلاين';

    -- A hostile client sends a price of its own. It is simply not read.
    v_token := app.place_public_order(
        'mosaiz-test', 'زبون', '01000000000',
        jsonb_build_array(jsonb_build_object(
            'item_id', v_item, 'quantity', 2, 'price', 0.01, 'unit_price', 0.01)));

    SELECT quoted_total INTO v_quoted FROM app.public_order_status(v_token);

    IF v_quoted <> v_menu * 2 THEN
        RAISE EXCEPTION 'THE CUSTOMER SET THE PRICE — quoted % for 2 x %', v_quoted, v_menu;
    END IF;

    RAISE NOTICE 'OK 2: quoted % for 2 x % — the menu decided, not the client', v_quoted, v_menu;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A request moves nothing.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_orders  int;
    v_pending int;
BEGIN
    -- No row in the real orders table, so no stock deducted and no cost
    -- captured. This null is the entire safety property of the design.
    SELECT count(*) INTO v_orders FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND accepted_order_id IS NOT NULL;
    IF v_orders <> 0 THEN
        RAISE EXCEPTION 'a public request became a real order with nobody accepting it';
    END IF;

    SELECT count(*) INTO v_pending FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'pending';
    IF v_pending = 0 THEN
        RAISE EXCEPTION 'the request did not reach the queue';
    END IF;

    RAISE NOTICE 'OK 3: % request(s) waiting, 0 stock moved', v_pending;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Nobody writes a request directly — not even the owner.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.public_orders
            (organization_id, customer_name, customer_phone, quoted_total)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'مزيّف', '0100', 0.01);
        RAISE EXCEPTION 'a request was filed directly, bypassing the pricing';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- The refusal above is ambiguous on its own — a missing GRANT and a policy
    -- refusal share a SQLSTATE — so the privilege is asserted directly.
    IF has_table_privilege('mosaiz_app_user', 'public.public_orders', 'INSERT')
       OR has_table_privilege('mosaiz_app_user', 'public.public_order_lines', 'INSERT') THEN
        RAISE EXCEPTION 'the application role can file public orders directly';
    END IF;

    RAISE NOTICE 'OK 4: requests arrive only through the procedure';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. The tenant comes from the slug. Another restaurant's dish is not orderable
--    here, and there is no parameter that says otherwise.
-- ----------------------------------------------------------------------------
RESET app.current_user_id;

DO $$
DECLARE
    v_foreign_item uuid := '5e11ab1e-000f-400f-800f-00000000000f';
BEGIN
    BEGIN
        PERFORM app.place_public_order(
            'mosaiz-test', 'زبون', '01000000000',
            jsonb_build_array(jsonb_build_object('item_id', v_foreign_item, 'quantity', 1)));
        RAISE EXCEPTION 'ordered another restaurant''s dish through this shopfront';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    -- An id that exists nowhere is the same refusal — the customer is never
    -- told which of the two it was.
    BEGIN
        PERFORM app.place_public_order(
            'mosaiz-test', 'زبون', '01000000000',
            jsonb_build_array(jsonb_build_object(
                'item_id', '00000000-0000-4000-8000-000000000000', 'quantity', 1)));
        RAISE EXCEPTION 'ordered an item that does not exist';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    RAISE NOTICE 'OK 5: only this shopfront''s own menu is orderable';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A closed shop, an unknown slug and a restaurant that does not do this at
--    all give the SAME answer — otherwise this becomes a directory of who uses
--    the product.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_unknown int;
BEGIN
    SELECT count(*) INTO v_unknown FROM app.public_menu('no-such-restaurant-here');
    IF v_unknown <> 0 THEN
        RAISE EXCEPTION 'an unknown slug returned a menu';
    END IF;

    BEGIN
        PERFORM app.place_public_order(
            'no-such-restaurant-here', 'زبون', '01000000000',
            jsonb_build_array(jsonb_build_object(
                'item_id', '00000000-0000-4000-8000-000000000000', 'quantity', 1)));
        RAISE EXCEPTION 'an order was accepted for a restaurant that does not exist';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    RAISE NOTICE 'OK 6: unknown and closed are indistinguishable from outside';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Closing the shop stops new orders and keeps the ones already taken.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_before int;
    v_after  int;
BEGIN
    SELECT count(*) INTO v_before FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';

    UPDATE public.storefronts SET is_accepting = false
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';

    PERFORM set_config('app.current_user_id', '', true);

    BEGIN
        PERFORM app.place_public_order(
            'mosaiz-test', 'متأخر', '01000000000',
            jsonb_build_array(jsonb_build_object(
                'item_id', '00000000-0000-4000-8000-000000000000', 'quantity', 1)));
        RAISE EXCEPTION 'an order was taken after closing';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    PERFORM set_config('app.current_user_id', 'f10c0004-0000-4000-8000-000000000004', true);

    SELECT count(*) INTO v_after FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'closing changed the orders already taken (% -> %)', v_before, v_after;
    END IF;

    UPDATE public.storefronts SET is_accepting = true
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';

    RAISE NOTICE 'OK 7: closed refuses new orders, keeps % existing', v_after;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. A tracking token unlocks a status word and nothing else — and somebody
--    else's token is not a way in.
-- ----------------------------------------------------------------------------
RESET app.current_user_id;

DO $$
DECLARE
    v_rows int;
BEGIN
    SELECT count(*) INTO v_rows
      FROM app.public_order_status('00000000-0000-4000-8000-0000000000ff');
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'an invented token returned an order';
    END IF;

    RAISE NOTICE 'OK 8: an unknown token returns nothing';
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. Staff see their own queue. Another restaurant's queue does not exist.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_ours    int;
    v_theirs  int;
BEGIN
    SELECT count(*) INTO v_ours FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_ours = 0 THEN
        RAISE EXCEPTION 'a waiter cannot see the queue they are meant to work';
    END IF;

    SELECT count(*) INTO v_theirs FROM public.public_orders
     WHERE organization_id <> 'f10c0000-0000-4000-8000-000000000000';
    IF v_theirs <> 0 THEN
        RAISE EXCEPTION 'another restaurant''s queue is visible (% rows)', v_theirs;
    END IF;

    RAISE NOTICE 'OK 9: % in our queue, 0 from anybody else', v_ours;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. The module gate: off means no shopfront at all, and the queue survives.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_before int;
    v_after  int;
    v_menu   int;
BEGIN
    SELECT count(*) INTO v_before FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'public_ordering', false);

    -- The shopfront vanishes from the outside even though is_accepting is true:
    -- the module is asked inside the function, because SECURITY DEFINER puts it
    -- outside RLS and 0037's policies therefore do not apply.
    SELECT count(*) INTO v_menu FROM app.public_menu('mosaiz-test');
    IF v_menu <> 0 THEN
        RAISE EXCEPTION 'the shopfront is still serving with the module switched off';
    END IF;

    SELECT count(*) INTO v_after FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'switching the module off changed the queue (% -> %)', v_before, v_after;
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'public_ordering', true);
    RAISE NOTICE 'OK 10: module off closes the shopfront, keeps % orders', v_after;
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. Accepting is what turns a request into a sale — and it happens under a
--     REAL identity, using the same checkout the till uses.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_req     uuid;
    v_orders_before int;
    v_orders_after  int;
    v_order   uuid;
    v_decider uuid;
BEGIN
    SELECT count(*) INTO v_orders_before FROM public.orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';

    SELECT id INTO v_req FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'pending'
     ORDER BY created_at LIMIT 1;

    IF v_req IS NULL THEN
        RAISE EXCEPTION 'nothing pending to accept — this section would be vacuous';
    END IF;

    v_order := app.accept_public_order(v_req);

    SELECT count(*) INTO v_orders_after FROM public.orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';

    -- NOW a real order exists. Not before.
    IF v_orders_after <> v_orders_before + 1 THEN
        RAISE EXCEPTION 'accepting did not produce exactly one order (% -> %)',
            v_orders_before, v_orders_after;
    END IF;

    SELECT decided_by INTO v_decider FROM public.public_orders WHERE id = v_req;
    IF v_decider IS DISTINCT FROM 'f10c0001-0000-4000-8000-000000000001' THEN
        RAISE EXCEPTION 'the acceptance does not name who made it (%)', v_decider;
    END IF;

    -- And it cannot be accepted twice into two sales.
    BEGIN
        PERFORM app.accept_public_order(v_req);
        RAISE EXCEPTION 'the same request was accepted twice';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    RAISE NOTICE 'OK 11: request became order %, accepted by the waiter', v_order;
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. A request in another restaurant's queue cannot be accepted, because it
--     cannot even be seen.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        PERFORM app.accept_public_order('0d0e4000-000f-400f-800f-00000000000f');
        RAISE EXCEPTION 'accepted another restaurant''s request';
    EXCEPTION WHEN no_data_found THEN
        NULL;
    END;

    -- And it is still sitting there, untouched, on their side.
    RAISE NOTICE 'OK 12: another restaurant''s queue is not ours to work';
END;
$$;

-- ----------------------------------------------------------------------------
-- 13. Rejecting needs a reason.
-- ----------------------------------------------------------------------------
RESET app.current_user_id;

DO $$
DECLARE
    v_token uuid;
    v_item  uuid;
BEGIN
    SELECT item_id INTO v_item FROM app.public_menu('mosaiz-test') LIMIT 1;
    v_token := app.place_public_order(
        'mosaiz-test', 'زبون آخر', '01011111111',
        jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1)));
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_req uuid;
BEGIN
    SELECT id INTO v_req FROM public.public_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'pending' LIMIT 1;

    BEGIN
        PERFORM app.reject_public_order(v_req, ' ');
        RAISE EXCEPTION 'an unexplained rejection was accepted';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    PERFORM app.reject_public_order(v_req, 'المطبخ مغلق الليلة');

    IF NOT EXISTS (SELECT FROM public.public_orders
                    WHERE id = v_req AND status = 'rejected'
                      AND rejection_reason = 'المطبخ مغلق الليلة'
                      AND decided_by = 'f10c0001-0000-4000-8000-000000000001') THEN
        RAISE EXCEPTION 'the rejection was not recorded properly';
    END IF;

    RAISE NOTICE 'OK 13: a rejection is explained and attributable';
END;
$$;

\echo 'public_ordering_verification: all checks passed'
