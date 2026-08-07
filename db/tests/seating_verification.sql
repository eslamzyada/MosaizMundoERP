-- ============================================================================
-- Verification: seating (0043)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--
-- What is worth proving:
--
--   1. THE ONE THAT MATTERS: one open tab per table. Two means somebody pays
--      for the other party's drinks, or the second walks out unpaid.
--   2. Seating is ONE act. A booking marked seated with no tab, or a tab with
--      no booking, is what two client-side steps produce on a bad connection.
--   3. Seating twice returns the SAME tab. A double tap must not cost a guest
--      two bills.
--   4. Orders with no table do not collide with each other — most orders have
--      no table, and a partial index that got that wrong would break the till.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'reservations', true);
END;
$$;

-- Its own table and bookings, rather than whatever an earlier suite left.
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
BEGIN
    INSERT INTO public.restaurant_tables (organization_id, label, seats)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'طاولة الجلوس', 4)
    ON CONFLICT (organization_id, label) DO NOTHING;
END;
$$;

-- ----------------------------------------------------------------------------
-- 1. Seating is one act: the booking changes AND the tab exists, together.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_table uuid;
    v_res   uuid;
    v_order uuid;
    v_status text;
    v_linked uuid;
    v_on_table uuid;
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة الجلوس';

    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'ضيف الجلوس', 4,
            now() + interval '1 hour', now() + interval '3 hours',
            'f10c0001-0000-4000-8000-000000000001')
    RETURNING id INTO v_res;

    v_order := app.seat_reservation(v_res);

    SELECT status, seated_order_id INTO v_status, v_linked
      FROM public.reservations WHERE id = v_res;
    IF v_status <> 'seated' THEN
        RAISE EXCEPTION 'the booking is % after seating', v_status;
    END IF;
    IF v_linked IS DISTINCT FROM v_order THEN
        RAISE EXCEPTION 'the booking does not point at its tab';
    END IF;

    SELECT table_id INTO v_on_table FROM public.orders WHERE id = v_order;
    IF v_on_table IS DISTINCT FROM v_table THEN
        RAISE EXCEPTION 'the tab was opened at the wrong table';
    END IF;

    IF (SELECT status FROM public.orders WHERE id = v_order) <> 'open' THEN
        RAISE EXCEPTION 'the tab is not open';
    END IF;

    RAISE NOTICE 'OK 1: booking seated, tab % open at the right table', v_order;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Seating twice returns the SAME tab.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_res    uuid;
    v_first  uuid;
    v_second uuid;
    v_tabs   int;
BEGIN
    SELECT id, seated_order_id INTO v_res, v_first FROM public.reservations
     WHERE guest_name = 'ضيف الجلوس';

    v_second := app.seat_reservation(v_res);

    IF v_second IS DISTINCT FROM v_first THEN
        RAISE EXCEPTION 'seating twice opened a second tab (% then %)', v_first, v_second;
    END IF;

    SELECT count(*) INTO v_tabs FROM public.orders
     WHERE table_id = (SELECT table_id FROM public.reservations WHERE id = v_res)
       AND status = 'open';
    IF v_tabs <> 1 THEN
        RAISE EXCEPTION 'the table has % open tabs', v_tabs;
    END IF;

    RAISE NOTICE 'OK 2: a double tap returns the same tab';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS: a second party cannot be seated at the same table
--    while a tab is open on it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_table uuid;
    v_res   uuid;
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة الجلوس';

    -- A later booking on the same table — legitimate, because the first
    -- sitting is due to end.
    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'ضيف ثانٍ', 2,
            now() + interval '4 hours', now() + interval '6 hours',
            'f10c0001-0000-4000-8000-000000000001')
    RETURNING id INTO v_res;

    BEGIN
        PERFORM app.seat_reservation(v_res);
        RAISE EXCEPTION 'TWO OPEN TABS ON ONE TABLE — somebody pays for the wrong drinks';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    -- ...and the refusal left the second booking alone.
    IF (SELECT status FROM public.reservations WHERE id = v_res) <> 'booked' THEN
        RAISE EXCEPTION 'the refused seating still changed the booking';
    END IF;

    RAISE NOTICE 'OK 3: one open tab per table, enforced';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Settling the tab finishes the booking, without anybody remembering to.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_order uuid;
    v_res   uuid;
    v_status text;
    v_item  uuid;
BEGIN
    SELECT id, seated_order_id INTO v_res, v_order FROM public.reservations
     WHERE guest_name = 'ضيف الجلوس';

    -- They order something. 0029 refuses to settle an empty tab, which is
    -- right — and it means the seated party has to actually eat before this
    -- section can prove anything.
    SELECT id INTO v_item FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND is_active LIMIT 1;
    IF v_item IS NULL THEN
        RAISE EXCEPTION 'no menu item — section 4 cannot settle a tab';
    END IF;

    PERFORM app.add_order_items(v_order,
        jsonb_build_array(jsonb_build_object('sellable_item_id', v_item, 'quantity', 1)));

    -- ...and it goes to the kitchen. 0029 refuses to settle a tab with items
    -- nobody cooked, which is the whole point of an open tab: the full path is
    -- open -> add -> fire -> settle, and this section walks it rather than
    -- reaching around it.
    PERFORM app.fire_order(v_order);

    -- app.settle_order, NOT a raw UPDATE. Orders carry a require_admin_update
    -- policy, so a waiter's direct UPDATE is filtered to zero rows and changes
    -- nothing — silently. Testing the real settlement path is also the point:
    -- the trigger has to fire on what the till actually does.
    PERFORM app.settle_order(v_order);

    SELECT status INTO v_status FROM public.reservations WHERE id = v_res;
    IF v_status <> 'completed' THEN
        RAISE EXCEPTION 'the booking is still % after the tab was settled', v_status;
    END IF;

    RAISE NOTICE 'OK 4: settling the tab closed the booking';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. ...and the table is free again, so the next party can sit down.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_res   uuid;
    v_order uuid;
BEGIN
    SELECT id INTO v_res FROM public.reservations WHERE guest_name = 'ضيف ثانٍ';

    v_order := app.seat_reservation(v_res);
    IF v_order IS NULL THEN
        RAISE EXCEPTION 'the table did not free up after the tab was settled';
    END IF;

    RAISE NOTICE 'OK 5: the table freed up, second party seated on tab %', v_order;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. A booking that is not waiting cannot be seated.
--
--    On a table that is FREE, and that matters: the first version put this
--    booking on the table the previous section had just filled, so it was
--    refused for being busy rather than for being cancelled. A counterfactual
--    that deleted the status check entirely sailed through it.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
BEGIN
    INSERT INTO public.restaurant_tables (organization_id, label, seats)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'طاولة فارغة', 2)
    ON CONFLICT (organization_id, label) DO NOTHING;
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_table uuid;
    v_res   uuid;
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة فارغة';

    IF EXISTS (SELECT FROM public.orders
                WHERE table_id = v_table AND status = 'open') THEN
        RAISE EXCEPTION 'the free table is not free — this section would be vacuous';
    END IF;

    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'ضيف ملغى', 2,
            now() + interval '8 hours', now() + interval '9 hours',
            'f10c0001-0000-4000-8000-000000000001')
    RETURNING id INTO v_res;

    UPDATE public.reservations SET status = 'cancelled' WHERE id = v_res;

    BEGIN
        PERFORM app.seat_reservation(v_res);
        RAISE EXCEPTION 'a cancelled booking was seated';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    RAISE NOTICE 'OK 6: a cancelled booking cannot be sat down';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Orders with NO table do not collide with each other.
--
--    The partial index keys on table_id, and NULLs must not compete — most
--    orders have no table, so getting this wrong would stop the till dead.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_a int;
BEGIN
    SELECT count(*) INTO v_a FROM public.orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'open' AND table_id IS NULL;

    PERFORM app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', gen_random_uuid(),
        'items', '[]'::jsonb));

    PERFORM app.open_order(jsonb_build_object(
        'organization_id', 'f10c0000-0000-4000-8000-000000000000',
        'client_offline_id', gen_random_uuid(),
        'items', '[]'::jsonb));

    IF (SELECT count(*) FROM public.orders
         WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
           AND status = 'open' AND table_id IS NULL) <> v_a + 2 THEN
        RAISE EXCEPTION 'two tableless tabs could not coexist — the till is broken';
    END IF;

    RAISE NOTICE 'OK 7: tabs with no table do not compete for the index';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Cross-tenant: another restaurant's booking is not ours to seat.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        -- A literal from the fixture: seeded as postgres, invisible here, and
        -- that invisibility is the point.
        PERFORM app.seat_reservation('0d0e4000-000f-400f-800f-00000000000f');
        RAISE EXCEPTION 'seated a booking in another restaurant';
    EXCEPTION WHEN no_data_found THEN
        NULL;
    END;

    RAISE NOTICE 'OK 8: another restaurant''s book is not ours';
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. A tab cannot be moved onto another restaurant's table.
--
--    Run as a MANAGER: orders carry require_admin_update, so a waiter's UPDATE
--    matches zero rows and this section would "pass" without ever reaching the
--    foreign key it is about.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_order uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'open' AND table_id IS NULL LIMIT 1;

    BEGIN
        UPDATE public.orders
           SET table_id = '7ab1e000-000f-400f-800f-00000000000f'
         WHERE id = v_order;
        RAISE EXCEPTION 'a tab was moved onto another restaurant''s table';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 9: the composite key keeps tabs on our own floor';
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. The module gate: no seating with reservations switched off, and the
--     tabs already open stay open.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_table  uuid;
    v_res    uuid;
    v_before int;
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة الجلوس';

    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'ضيف بعد الإيقاف', 2,
            now() + interval '20 hours', now() + interval '21 hours',
            'f10c0004-0000-4000-8000-000000000004')
    RETURNING id INTO v_res;

    SELECT count(*) INTO v_before FROM public.orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000' AND status = 'open';

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'reservations', false);

    BEGIN
        PERFORM app.seat_reservation(v_res);
        RAISE EXCEPTION 'seated somebody with the module switched off';
    EXCEPTION WHEN feature_not_supported THEN
        NULL;
    END;

    IF (SELECT count(*) FROM public.orders
         WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
           AND status = 'open') <> v_before THEN
        RAISE EXCEPTION 'switching the module off changed the open tabs';
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'reservations', true);
    RAISE NOTICE 'OK 10: no new seating, % tabs untouched', v_before;
END;
$$;

\echo 'seating_verification: all checks passed'
