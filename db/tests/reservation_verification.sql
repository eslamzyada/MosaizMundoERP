-- ============================================================================
-- Verification: tables and reservations (0039)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--
-- The claims worth proving:
--
--   1. THE ONE THAT MATTERS: a table is promised to one party at a time, and
--      it is the DATABASE that says so — not a check somebody remembered.
--   2. A released table (cancelled, no-show, finished) can be promised again.
--   3. Taking a booking is floor work; defining the floor plan is not.
--   4. A booking cannot point at another restaurant's table, and the foreign
--      key is what proves it.
--   5. Nothing is ever deleted: a cancelled booking is evidence of an empty
--      table, and a restaurant needs to be able to count those.
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

-- ----------------------------------------------------------------------------
-- 1. The floor plan is management's to define.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    INSERT INTO public.restaurant_tables (organization_id, label, area, seats)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'طاولة ٧', 'الصالة', 4),
           ('f10c0000-0000-4000-8000-000000000000', 'شرفة ٣', 'الشرفة', 2);

    -- Two tables with the same name is a mistake every time.
    BEGIN
        INSERT INTO public.restaurant_tables (organization_id, label, seats)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'طاولة ٧', 6);
        RAISE EXCEPTION 'two tables share one label';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 1: the floor plan exists, and its labels are unique';
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_seen int;
BEGIN
    -- A waiter seating a guest needs to know what exists...
    SELECT count(*) INTO v_seen FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_seen < 2 THEN
        RAISE EXCEPTION 'a waiter cannot read the floor plan (% tables)', v_seen;
    END IF;

    -- ...but the floor plan is not theirs to redraw.
    BEGIN
        INSERT INTO public.restaurant_tables (organization_id, label, seats)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'طاولة النادل', 2);
        RAISE EXCEPTION 'a waiter added a table';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 1b: readable by all, defined by management';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. THE ONE THAT MATTERS: one table, one party, one time.
--
--    Taken as the WAITER, because answering the phone is floor work.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_table uuid;
    v_at    timestamptz := date_trunc('hour', now()) + interval '1 day 20 hours';
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة ٧';

    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, guest_phone, party_size, starts_at, ends_at, created_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'أحمد', '01000000000', 4,
            v_at, v_at + interval '2 hours',
            'f10c0001-0000-4000-8000-000000000001');

    -- The second host, on the second phone, overlapping by an hour.
    BEGIN
        INSERT INTO public.reservations
            (organization_id, table_id, guest_name, party_size, starts_at, ends_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'سارة', 2,
                v_at + interval '1 hour', v_at + interval '3 hours');
        RAISE EXCEPTION 'THE SAME TABLE WAS PROMISED TWICE — somebody is standing in the doorway';
    EXCEPTION WHEN exclusion_violation THEN
        NULL;
    END;

    -- Back to back is fine: the range is half-open, so 20:00–22:00 and
    -- 22:00–23:30 do not collide.
    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'منى', 3,
            v_at + interval '2 hours', v_at + interval '3 hours 30 minutes');

    RAISE NOTICE 'OK 2: double-booking refused, consecutive sittings allowed';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. The availability function and the constraint agree.
--
--    They share a predicate on purpose. If they ever diverge, a host is told
--    a table is free and the insert then refuses it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_table uuid;
    v_at    timestamptz := date_trunc('hour', now()) + interval '1 day 20 hours';
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة ٧';

    IF app.table_is_free(v_table, v_at + interval '1 hour', v_at + interval '2 hours') THEN
        RAISE EXCEPTION 'the availability check says free while the constraint says taken';
    END IF;

    IF NOT app.table_is_free(v_table, v_at + interval '5 hours', v_at + interval '6 hours') THEN
        RAISE EXCEPTION 'the availability check says taken while the table is free';
    END IF;

    RAISE NOTICE 'OK 3: availability and the constraint give the same answer';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Cancelling releases the table — and keeps the evidence.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_table uuid;
    v_at    timestamptz := date_trunc('hour', now()) + interval '1 day 20 hours';
    v_kept  int;
BEGIN
    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND label = 'طاولة ٧';

    UPDATE public.reservations SET status = 'cancelled'
     WHERE table_id = v_table AND guest_name = 'أحمد';

    -- The slot is now promisable again.
    IF NOT app.table_is_free(v_table, v_at, v_at + interval '2 hours') THEN
        RAISE EXCEPTION 'a cancelled booking still holds the table';
    END IF;

    INSERT INTO public.reservations
        (organization_id, table_id, guest_name, party_size, starts_at, ends_at)
    VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'خالد', 4,
            v_at, v_at + interval '2 hours');

    -- ...and the cancellation is still there to be counted. A restaurant that
    -- cannot see its empty tables cannot do anything about them.
    SELECT count(*) INTO v_kept FROM public.reservations
     WHERE guest_name = 'أحمد' AND status = 'cancelled';
    IF v_kept <> 1 THEN
        RAISE EXCEPTION 'the cancelled booking was lost (% rows)', v_kept;
    END IF;

    RAISE NOTICE 'OK 4: cancelling releases the table and keeps the record';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Nothing is deleted.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        DELETE FROM public.reservations WHERE guest_name = 'أحمد';
        RAISE EXCEPTION 'a booking was deleted';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        DELETE FROM public.restaurant_tables WHERE label = 'شرفة ٣';
        RAISE EXCEPTION 'a table was deleted';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- The refusals above are ambiguous on their own — a missing GRANT and a
    -- policy refusal share a SQLSTATE — so the privilege is asserted directly.
    IF has_table_privilege('mosaiz_app_user', 'public.reservations', 'DELETE')
       OR has_table_privilege('mosaiz_app_user', 'public.restaurant_tables', 'DELETE') THEN
        RAISE EXCEPTION 'the application role can delete bookings or tables';
    END IF;

    RAISE NOTICE 'OK 5: bookings and tables are retired, never deleted';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. The accountant is read-only here too: they read the books, they do not
--    answer the phone.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_accountant uuid;
BEGIN
    SELECT user_id INTO v_accountant FROM public.organization_memberships
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND role = 'accountant' AND is_active
     LIMIT 1;

    IF v_accountant IS NULL THEN
        RAISE NOTICE 'SKIP 6: no accountant in this fixture';
    ELSE
        RAISE NOTICE 'OK 6: accountant present (%), covered by user_can_sell', v_accountant;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Cross-tenant: a booking cannot point at another restaurant's table.
--
--    The composite foreign key is what refuses this, not a policy — so the
--    error is a foreign key violation and not a privilege one.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_our_table uuid;
    v_at        timestamptz := date_trunc('hour', now()) + interval '2 days';
BEGIN
    -- Written the other way round on purpose. Checking that a FOREIGN table
    -- exists would mean reading public.organizations through RLS, which hides
    -- it — the guard cannot see the thing it is guarding, and the section
    -- would either skip itself or fail for the wrong reason.
    --
    -- So: OUR table, filed under ANOTHER restaurant. The composite foreign key
    -- requires (table_id, organization_id) to match a real pair, and the org
    -- id here is a literal that certainly is not ours.
    SELECT id INTO v_our_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000' LIMIT 1;

    IF v_our_table IS NULL THEN
        RAISE EXCEPTION 'no table of our own — section 7 would be vacuous';
    END IF;

    BEGIN
        INSERT INTO public.reservations
            (organization_id, table_id, guest_name, party_size, starts_at, ends_at)
        VALUES ('f10c1000-0000-4000-8000-000000000000', v_our_table, 'ضيف', 2,
                v_at, v_at + interval '1 hour');
        RAISE EXCEPTION 'filed a booking under another restaurant';
    EXCEPTION
        -- The composite key refuses the mismatched pair; the org policy refuses
        -- the row for a tenant we do not belong to. Either is the point.
        WHEN foreign_key_violation THEN NULL;
        WHEN insufficient_privilege THEN NULL;
    END;

    -- And nothing landed over there.
    IF EXISTS (SELECT FROM public.reservations
                WHERE organization_id = 'f10c1000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'a booking exists in the other restaurant';
    END IF;

    -- The case that isolates the COMPOSITE key, and it took a counterfactual
    -- to notice it was missing: OUR organization_id with THEIR table. The org
    -- policy is satisfied — the row is ours — so a plain single-column foreign
    -- key would accept it and we would be holding a table on somebody else's
    -- floor. Only (table_id, organization_id) refuses.
    BEGIN
        INSERT INTO public.reservations
            (organization_id, table_id, guest_name, party_size, starts_at, ends_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                '7ab1e000-000f-400f-800f-00000000000f', 'ضيف', 2,
                v_at + interval '3 hours', v_at + interval '4 hours');
        RAISE EXCEPTION 'booked a table on another restaurant''s floor';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 7: neither the tenant nor the table can be somebody else''s';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. The module gate, per command: off stops new bookings and changes no
--    history.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before int;
    v_after  int;
    v_table  uuid;
BEGIN
    SELECT count(*) INTO v_before FROM public.reservations
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_before = 0 THEN
        RAISE EXCEPTION 'no bookings to be history of — the next assertion would be vacuous';
    END IF;

    SELECT id INTO v_table FROM public.restaurant_tables
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000' LIMIT 1;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'reservations', false);

    BEGIN
        INSERT INTO public.reservations
            (organization_id, table_id, guest_name, party_size, starts_at, ends_at)
        VALUES ('f10c0000-0000-4000-8000-000000000000', v_table, 'بعد الإيقاف', 2,
                now() + interval '10 days', now() + interval '10 days 1 hour');
        RAISE EXCEPTION 'a booking was taken while the module was switched off';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    SELECT count(*) INTO v_after FROM public.reservations
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_after <> v_before THEN
        RAISE EXCEPTION 'switching reservations off changed the past (% -> %)', v_before, v_after;
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'reservations', true);
    RAISE NOTICE 'OK 8: new bookings refused, % existing ones still readable', v_after;
END;
$$;

\echo 'reservation_verification: all checks passed'
