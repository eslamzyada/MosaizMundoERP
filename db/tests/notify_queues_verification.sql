-- ============================================================================
-- Verification: notifications for the new queues (0041)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--
-- A notification is only worth sending if the person receiving it can act on
-- it now. So half of what this suite proves is about silence:
--
--   1. A customer's order reaches the floor, with NO actor — nobody who works
--      here placed it.
--   2. A shift reaches the person ON it, and never the manager who typed it.
--   3. A booking three weeks out reaches nobody. That restraint is the whole
--      difference between a bell people read and a bell people dismiss.
-- ============================================================================

\set ON_ERROR_STOP on

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.organizations
                    WHERE id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'fixture missing: run floor_roles_fixture.sql first';
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'labour', true);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'reservations', true);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'public_ordering', true);
END;
$$;

-- Everybody starts from a known inbox, so every count below is about THIS
-- suite rather than about whatever ran before it.
DO $$
DECLARE
    v_marked int;
BEGIN
    -- Only the caller's own can be marked read; each identity clears its own
    -- below. This is the owner's.
    UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL;
    GET DIAGNOSTICS v_marked = ROW_COUNT;
    RAISE NOTICE 'setup: owner cleared % of their own', v_marked;
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';
UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL;
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';
UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL;
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';
UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL;
SET app.current_user_id = 'f10c0005-0000-4000-8000-000000000005';
UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL;

-- ----------------------------------------------------------------------------
-- 1. A customer is waiting, and the floor is told.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_item uuid;
BEGIN
    -- The slug too, not just the switch: public_ordering_verification runs
    -- before this and already owns a storefront for this restaurant. An upsert
    -- that set only is_accepting would leave the OTHER suite's slug in place,
    -- and every call below would be told the shop does not exist.
    INSERT INTO public.storefronts (organization_id, slug, display_name, is_accepting)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'notify-test-shop',
            'مطعم الإشعارات', true)
    ON CONFLICT (organization_id) DO UPDATE
        SET slug = EXCLUDED.slug, is_accepting = true;

    SELECT id INTO v_item FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND is_active LIMIT 1;
    IF v_item IS NULL THEN
        RAISE EXCEPTION 'no menu item — section 1 would be vacuous';
    END IF;
END;
$$;

-- The order itself arrives with NO identity, the way a real one does.
RESET app.current_user_id;

DO $$
DECLARE
    v_item uuid;
BEGIN
    SELECT item_id INTO v_item FROM app.public_menu('notify-test-shop') LIMIT 1;
    PERFORM app.place_public_order(
        'notify-test-shop', 'زبون الإنترنت', '01000000000',
        jsonb_build_array(jsonb_build_object('item_id', v_item, 'quantity', 1)));
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_actor uuid;
    v_link  text;
    v_count int;
BEGIN
    SELECT count(*) INTO v_count FROM public.notifications
     WHERE kind = 'public_order_placed' AND read_at IS NULL;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'the waiter was not told a customer is waiting';
    END IF;

    SELECT actor_id, link INTO v_actor, v_link FROM public.notifications
     WHERE kind = 'public_order_placed' ORDER BY created_at DESC LIMIT 1;

    -- Nobody who works here placed it. An actor would be a lie about who did.
    IF v_actor IS NOT NULL THEN
        RAISE EXCEPTION 'a public order was attributed to a member of staff (%)', v_actor;
    END IF;
    IF v_link IS DISTINCT FROM '/online-orders' THEN
        RAISE EXCEPTION 'the notification does not point at the queue (%)', v_link;
    END IF;

    RAISE NOTICE 'OK 1: the floor was told, with no actor, pointing at %', v_link;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. The cashier is NOT told. Their tool is the till.
-- ----------------------------------------------------------------------------
-- Read AS THE CASHIER. This has to be their own inbox, and the reason is the
-- trap that made the first version of this section worthless: asking, as the
-- waiter, for rows whose recipient is the cashier returns nothing whether they
-- were notified or not — the own-row policy hides them either way. A
-- counterfactual that added 'cashier' to the notified roles sailed through it.
SET app.current_user_id = 'f10c0007-0000-4000-8000-000000000007';

DO $$
DECLARE
    v_seen int;
BEGIN
    -- Guard first: if the fixture ever loses its cashier, this section must
    -- fail loudly rather than quietly assert nothing.
    IF NOT EXISTS (SELECT FROM public.organization_memberships
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                      AND user_id = 'f10c0007-0000-4000-8000-000000000007'
                      AND role = 'cashier' AND is_active) THEN
        RAISE EXCEPTION 'no cashier in the fixture — this section would be vacuous';
    END IF;

    SELECT count(*) INTO v_seen FROM public.notifications
     WHERE kind = 'public_order_placed';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'the cashier was told about an online order (% rows)', v_seen;
    END IF;

    RAISE NOTICE 'OK 2: the cashier was not disturbed';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A shift reaches the person on it — and not the manager who wrote it.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_start timestamptz := date_trunc('hour', now()) + interval '10 days';
    v_told  int;
BEGIN
    INSERT INTO public.shifts (organization_id, user_id, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000',
            'f10c0002-0000-4000-8000-000000000002',
            v_start, v_start + interval '8 hours',
            'f10c0003-0000-4000-8000-000000000003');

    -- The manager typed it; they already know.
    SELECT count(*) INTO v_told FROM public.notifications
     WHERE kind IN ('shift_scheduled', 'shift_changed') AND read_at IS NULL;
    IF v_told <> 0 THEN
        RAISE EXCEPTION 'the manager was told about a shift they wrote (%)', v_told;
    END IF;

    RAISE NOTICE 'OK 3: the author was not told';
END;
$$;

SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_subject text;
    v_link    text;
BEGIN
    SELECT subject, link INTO v_subject, v_link FROM public.notifications
     WHERE kind = 'shift_scheduled' ORDER BY created_at DESC LIMIT 1;

    IF v_subject IS NULL THEN
        RAISE EXCEPTION 'the person on the shift was never told';
    END IF;
    IF v_link IS DISTINCT FROM '/schedule' THEN
        RAISE EXCEPTION 'the shift notification points at % instead of the rota', v_link;
    END IF;

    RAISE NOTICE 'OK 3b: the kitchen was told — %', v_subject;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Moving the hours is news. Editing a note is not.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_shift uuid;
BEGIN
    SELECT id INTO v_shift FROM public.shifts
     WHERE user_id = 'f10c0002-0000-4000-8000-000000000002'
     ORDER BY starts_at DESC LIMIT 1;

    UPDATE public.shifts SET note = 'ملاحظة لا تغيّر شيئًا' WHERE id = v_shift;
END;
$$;

SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_changed int;
BEGIN
    SELECT count(*) INTO v_changed FROM public.notifications
     WHERE kind = 'shift_changed';
    IF v_changed <> 0 THEN
        RAISE EXCEPTION 'a note edit was announced as a change to somebody''s hours';
    END IF;
    RAISE NOTICE 'OK 4: editing a note told nobody';
END;
$$;

SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_shift uuid;
BEGIN
    SELECT id INTO v_shift FROM public.shifts
     WHERE user_id = 'f10c0002-0000-4000-8000-000000000002'
     ORDER BY starts_at DESC LIMIT 1;

    UPDATE public.shifts
       SET starts_at = starts_at + interval '1 hour',
           ends_at   = ends_at + interval '1 hour'
     WHERE id = v_shift;
END;
$$;

SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.notifications WHERE kind = 'shift_changed') THEN
        RAISE EXCEPTION 'the hours moved and nobody was told';
    END IF;
    RAISE NOTICE 'OK 4b: moving the hours was announced';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. THE RESTRAINT: a booking for today is news, one for next month is not.
-- ----------------------------------------------------------------------------
-- A table of its own, rather than one reservation_verification happened to
-- leave behind. Depending on another suite's side effects means this one
-- passes or fails according to the order CI runs things in, which is not a
-- property of the code under test.
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
BEGIN
    INSERT INTO public.restaurant_tables (organization_id, label, seats)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'طاولة الإشعارات', 4)
    ON CONFLICT (organization_id, label) DO NOTHING;
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_table uuid;
    v_far   int;
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة الإشعارات';

    IF v_table IS NULL THEN
        RAISE EXCEPTION 'no table — section 5 would be vacuous';
    END IF;

    -- Three weeks out. Nobody does anything about this today.
    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'ضيف بعيد', 2,
            now() + interval '21 days', now() + interval '21 days 2 hours',
            'f10c0001-0000-4000-8000-000000000001');

    RAISE NOTICE 'OK 5: distant booking created by the waiter';
END;
$$;

-- Checked in the BRANCH MANAGER's inbox, not the waiter's.
--
-- The waiter created that booking, and notify_roles skips the actor — so their
-- own inbox stays empty whether the 24-hour window exists or not. Reading it
-- proved nothing, and a counterfactual that deleted the window entirely sailed
-- straight through this section.
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_far int;
BEGIN
    SELECT count(*) INTO v_far FROM public.notifications
     WHERE kind = 'reservation_today';
    IF v_far <> 0 THEN
        RAISE EXCEPTION 'a booking three weeks out rang the bell (% rows)', v_far;
    END IF;

    RAISE NOTICE 'OK 5b: a distant booking told nobody who could not act on it';
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_table uuid;
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة الإشعارات';

    -- Tonight, taken by the WAITER — so the manager below is a recipient
    -- rather than the actor, and the assertion is about delivery.
    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'ضيف الليلة', 4,
            now() + interval '3 hours', now() + interval '5 hours',
            'f10c0001-0000-4000-8000-000000000001');
END;
$$;

SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_body text;
BEGIN
    SELECT body INTO v_body FROM public.notifications
     WHERE kind = 'reservation_today' ORDER BY created_at DESC LIMIT 1;

    IF v_body IS NULL THEN
        RAISE EXCEPTION 'a booking for tonight told nobody';
    END IF;
    -- The name and the table, because that is what somebody acts on.
    IF v_body NOT LIKE '%ضيف الليلة%' THEN
        RAISE EXCEPTION 'the booking notification does not name the guest: %', v_body;
    END IF;

    RAISE NOTICE 'OK 5b: tonight''s booking reached the floor — %', v_body;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. None of this weakened 0036: the application still cannot write one, and
--    an inbox is still private.
--
--    The identity is set explicitly rather than inherited from whatever the
--    section above happened to leave behind. It was inherited once, the
--    sections above were re-aimed at a different reader, and this assertion
--    started reporting a privacy breach that was really just the wrong id.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_others int;
BEGIN
    IF has_table_privilege('mosaiz_app_user', 'public.notifications', 'INSERT') THEN
        RAISE EXCEPTION 'the application role gained INSERT on notifications';
    END IF;

    SELECT count(*) INTO v_others FROM public.notifications
     WHERE recipient_id <> 'f10c0001-0000-4000-8000-000000000001';
    IF v_others <> 0 THEN
        RAISE EXCEPTION 'the waiter can read % notifications addressed to others', v_others;
    END IF;

    RAISE NOTICE 'OK 6: 0036''s guarantees are intact';
END;
$$;

\echo 'notify_queues_verification: all checks passed'
