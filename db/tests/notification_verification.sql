-- ============================================================================
-- Verification: notifications (0036)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--
-- A notification is a copy of information delivered OUTSIDE the query path, so
-- the things worth proving are all about what it can carry past a policy:
--
--   1. Nobody can write one. The application role has no INSERT at all, so a
--      controller cannot address a message to somebody — which is what would
--      let it phish them.
--   2. Nobody reads anybody else's inbox.
--   3. "Mark as read" cannot rewrite the message it acknowledges.
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

-- ----------------------------------------------------------------------------
-- 1. THE ONE THAT MATTERS: the application role cannot write a notification.
--
--    Attempted as the OWNER. If the highest role cannot address a message to
--    somebody, no controller bug can either.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.notifications
            (organization_id, recipient_id, kind, subject)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0001-0000-4000-8000-000000000001',
                'phish', 'اضغط هنا لتأكيد كلمة المرور');
        RAISE EXCEPTION 'THE OWNER SENT A NOTIFICATION DIRECTLY — anyone can phish anyone';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- The refusal above is ambiguous on its own: a row-level CHECK violation
    -- and a missing privilege BOTH raise insufficient_privilege, so it passes
    -- either way. This is the one that distinguishes them — addressed to
    -- SELF, which the own-row policy permits. Only the absent INSERT grant
    -- can refuse it.
    BEGIN
        INSERT INTO public.notifications
            (organization_id, recipient_id, kind, subject)
        VALUES ('f10c0000-0000-4000-8000-000000000000',
                'f10c0004-0000-4000-8000-000000000004',
                'self', 'ملاحظة كتبتها لنفسي');
        RAISE EXCEPTION 'the application role can write notifications (self-addressed)';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- And said plainly, so a future migration that hands out the privilege
    -- fails here rather than in whatever it was trying to make convenient.
    IF has_table_privilege('mosaiz_app_user', 'public.notifications', 'INSERT') THEN
        RAISE EXCEPTION 'the application role holds INSERT on notifications';
    END IF;
    IF has_table_privilege('mosaiz_app_user', 'public.notifications', 'DELETE') THEN
        RAISE EXCEPTION 'the application role can delete a notification it was sent';
    END IF;
    IF has_column_privilege('mosaiz_app_user', 'public.notifications', 'subject', 'UPDATE') THEN
        RAISE EXCEPTION 'the application role can rewrite the message';
    END IF;
    IF NOT has_column_privilege('mosaiz_app_user', 'public.notifications', 'read_at', 'UPDATE') THEN
        RAISE EXCEPTION 'nothing can ever be marked read';
    END IF;

    -- ...and cannot call the delivery function to get around it.
    BEGIN
        PERFORM app.notify_user('f10c0000-0000-4000-8000-000000000000',
                                'f10c0001-0000-4000-8000-000000000001',
                                'phish', 'رسالة منتحلة');
        RAISE EXCEPTION 'the delivery function is callable from the application role';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 1: notifications cannot be written by the application';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Proposing a menu change tells the deciders — and only them.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_req uuid;
BEGIN
    INSERT INTO public.menu_change_requests
        (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'create', 'سلطة الشيف', 40,
            'إضافة خيار خفيف لقائمة الغداء',
            'f10c0002-0000-4000-8000-000000000002')
    RETURNING id INTO v_req;

    -- The kitchen proposed it, so the kitchen is told nothing.
    IF EXISTS (SELECT FROM public.notifications
                WHERE recipient_id = 'f10c0002-0000-4000-8000-000000000002'
                  AND kind = 'menu_change_proposed') THEN
        RAISE EXCEPTION 'the proposer was notified of their own proposal';
    END IF;

    RAISE NOTICE 'OK 2: proposing does not notify the proposer (%)', v_req;
END;
$$;

-- The owner is told. Read as the owner, because that is the only way to see it.
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_count int;
    v_link  text;
BEGIN
    SELECT count(*) INTO v_count FROM public.notifications
     WHERE kind = 'menu_change_proposed' AND read_at IS NULL;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'the owner was not told about a pending menu change';
    END IF;

    SELECT link INTO v_link FROM public.notifications
     WHERE kind = 'menu_change_proposed' ORDER BY created_at DESC LIMIT 1;
    IF v_link IS DISTINCT FROM '/menu' THEN
        RAISE EXCEPTION 'the notification does not point anywhere useful (%)', v_link;
    END IF;

    RAISE NOTICE 'OK 2b: the owner has % unread, pointing at %', v_count, v_link;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A waiter is NOT told. This is the containment check: the delivery function
--    picks recipients by role, and a role that cannot decide is not addressed.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.notifications;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'a waiter sees % notifications', v_seen;
    END IF;
    RAISE NOTICE 'OK 3: a waiter sees an empty inbox';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Nobody reads anybody else's inbox — including a branch manager, who
--    outranks the waiter and still sees nothing addressed to the owner.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.notifications
     WHERE recipient_id = 'f10c0004-0000-4000-8000-000000000004';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'a branch manager can read the owner''s inbox (% rows)', v_seen;
    END IF;
    RAISE NOTICE 'OK 4: an inbox is private to its owner';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Deciding tells the proposer, and nobody else.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_req uuid;
BEGIN
    SELECT id INTO v_req FROM public.menu_change_requests
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'pending' AND proposed_name = 'سلطة الشيف';

    PERFORM app.decide_menu_change(v_req, true, 'موافق، جرّبه لشهر');

    -- The owner decided, so the owner is told nothing new about it.
    IF EXISTS (SELECT FROM public.notifications
                WHERE kind = 'menu_change_decided') THEN
        RAISE EXCEPTION 'the decider was notified of their own decision';
    END IF;
END;
$$;

SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_subject text;
BEGIN
    SELECT subject INTO v_subject FROM public.notifications
     WHERE kind = 'menu_change_decided' ORDER BY created_at DESC LIMIT 1;

    IF v_subject IS NULL THEN
        RAISE EXCEPTION 'the proposer was never told the outcome';
    END IF;
    IF v_subject NOT LIKE '%اعتماد%' THEN
        RAISE EXCEPTION 'the outcome notification does not say what happened: %', v_subject;
    END IF;

    RAISE NOTICE 'OK 5: the proposer was told — %', v_subject;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Marking read is the ONLY thing a reader may change.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id      uuid;
    v_subject text;
BEGIN
    SELECT id, subject INTO v_id, v_subject FROM public.notifications
     WHERE recipient_id = 'f10c0002-0000-4000-8000-000000000002' LIMIT 1;

    UPDATE public.notifications SET read_at = now() WHERE id = v_id;
    IF (SELECT read_at FROM public.notifications WHERE id = v_id) IS NULL THEN
        RAISE EXCEPTION 'a reader could not mark their own notification read';
    END IF;

    -- The message itself is not theirs to edit. A column-level grant is what
    -- makes this a privilege error rather than a policy that has to guess.
    BEGIN
        UPDATE public.notifications SET subject = 'شيء آخر تمامًا' WHERE id = v_id;
        RAISE EXCEPTION 'a reader rewrote the message they were sent';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    IF (SELECT subject FROM public.notifications WHERE id = v_id) <> v_subject THEN
        RAISE EXCEPTION 'the subject changed despite the refusal';
    END IF;

    RAISE NOTICE 'OK 6: read_at is writable, the message is not';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Nobody marks somebody else's notification as read.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_id uuid;
BEGIN
    -- Read the target as the OWNER would; the waiter cannot see it, which is
    -- the point, so the id comes from a fixed lookup rather than a SELECT here.
    SELECT id INTO v_id FROM public.notifications
     WHERE recipient_id = 'f10c0001-0000-4000-8000-000000000001' LIMIT 1;

    IF v_id IS NOT NULL THEN
        RAISE EXCEPTION 'the waiter has notifications and should not';
    END IF;

    -- An UPDATE the policy refuses matches zero rows rather than raising, so
    -- the assertion is about the EFFECT: the owner's row stays unread.
    UPDATE public.notifications SET read_at = now()
     WHERE kind = 'menu_change_proposed';

    RAISE NOTICE 'OK 7: a waiter''s update reaches nothing';
END;
$$;

SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.notifications
                    WHERE kind = 'menu_change_proposed' AND read_at IS NULL) THEN
        RAISE EXCEPTION 'somebody else marked the owner''s notification as read';
    END IF;
    RAISE NOTICE 'OK 7b: the owner''s notification is still unread';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Cross-tenant: another restaurant's notifications do not exist here.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.notifications
     WHERE organization_id <> 'f10c0000-0000-4000-8000-000000000000';
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'notifications from another restaurant are visible (%)', v_seen;
    END IF;
    RAISE NOTICE 'OK 8: the inbox is scoped to this restaurant';
END;
$$;

\echo 'notification_verification: all checks passed'
