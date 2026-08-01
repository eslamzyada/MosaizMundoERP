-- ============================================================================
-- Verification: the menu approval cycle (0035)
--
-- Runs as mosaiz_app_user. Identities come from floor_roles_fixture.sql, which
-- seeds one member per role in ci-floor-org:
--
--   f10c0000 organization      f10c0004 owner
--   f10c0005 regional manager   f10c0003 branch manager
--   f10c0002 kitchen            f10c0001 waiter
--   f10c1000 a SECOND restaurant whose only approver is f10c0006
--
-- THE CLAIM THIS SUITE EXISTS TO PROVE is section 1: the application role can
-- no longer write to sellable_items at all. Every other assertion here is about
-- the cycle being usable; that one is about it being unavoidable. If the
-- privilege ever comes back, the whole feature becomes a convention that the
-- next endpoint can forget.
-- ============================================================================

\set ON_ERROR_STOP on

-- The identity is bound BEFORE the guard. This suite reads through RLS like
-- everything else, so running the check as nobody reports the organization
-- missing when it is present — a false alarm indistinguishable from a real one.
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
-- 1. THE ONE THAT MATTERS: the menu is not writable, by anybody, directly.
--
--    Attempted as the OWNER — the most privileged role there is. If the highest
--    role in the system cannot do it, no role can, and the 0010 admin policies
--    are no longer what is holding the door.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_item uuid;
BEGIN
    SELECT id INTO v_item FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000' LIMIT 1;
    IF v_item IS NULL THEN
        RAISE EXCEPTION 'fixture missing: the floor org has no menu item';
    END IF;

    BEGIN
        UPDATE public.sellable_items SET price = 999 WHERE id = v_item;
        RAISE EXCEPTION 'THE OWNER RE-PRICED THE MENU DIRECTLY — the cycle is decorative';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    BEGIN
        INSERT INTO public.sellable_items (organization_id, name, price)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'طبق مهرّب', 10);
        RAISE EXCEPTION 'THE OWNER ADDED A DISH DIRECTLY — the cycle is decorative';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 1: sellable_items is not writable by the application role';
END;
$$;

-- ...and reading it still works, because the till has to sell from it.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000') THEN
        RAISE EXCEPTION 'the menu became unreadable, which breaks the till';
    END IF;
    RAISE NOTICE 'OK 1b: the menu is still readable';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. The kitchen proposes. A waiter cannot.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO public.menu_change_requests
        (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'create',
            'كبدة إسكندراني', 65.00,
            'صنف موسمي طلبه الزبائن كثيرًا هذا الشهر',
            'f10c0002-0000-4000-8000-000000000002')
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'the kitchen could not propose a menu change';
    END IF;
    RAISE NOTICE 'OK 2: the kitchen proposed a new dish (%)', v_id;
END;
$$;

SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
BEGIN
    BEGIN
        INSERT INTO public.menu_change_requests
            (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'create', 'طبق النادل', 20,
                'اقتراح من النادل', 'f10c0001-0000-4000-8000-000000000001');
        RAISE EXCEPTION 'a waiter proposed a menu change';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'OK 2b: a waiter cannot propose';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Nobody proposes AS somebody else.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
BEGIN
    BEGIN
        INSERT INTO public.menu_change_requests
            (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'create', 'طبق منتحل', 30,
                'منسوب لشخص آخر', 'f10c0004-0000-4000-8000-000000000004');
        RAISE EXCEPTION 'a request was filed in somebody else''s name';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'OK 3: requested_by cannot be forged';
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A waiter READS the queue — the price they quote is about to change.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.menu_change_requests
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000' AND status = 'pending';
    IF v_seen = 0 THEN
        RAISE EXCEPTION 'a waiter cannot see the pending queue';
    END IF;
    RAISE NOTICE 'OK 4: a waiter can read the queue (% pending)', v_seen;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. A branch manager cannot DECIDE — that is the owner or the regional manager.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_request uuid;
BEGIN
    SELECT id INTO v_request FROM public.menu_change_requests
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'pending' LIMIT 1;

    BEGIN
        PERFORM app.decide_menu_change(v_request, true, NULL);
        RAISE EXCEPTION 'a branch manager approved a menu change';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'OK 5: a branch manager cannot decide';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. THE TWO-PERSON RULE: the proposer cannot approve their own request.
--
--    The regional manager files one, then tries to wave it through. This org
--    has two approvers, so the exception for a lone approver does not apply.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0005-0000-4000-8000-000000000005';

DO $$
DECLARE
    v_own uuid;
BEGIN
    INSERT INTO public.menu_change_requests
        (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'create', 'طبق المدير', 90,
            'اقتراح من المدير الإقليمي', 'f10c0005-0000-4000-8000-000000000005')
    RETURNING id INTO v_own;

    BEGIN
        PERFORM app.decide_menu_change(v_own, true, 'موافق');
        RAISE EXCEPTION 'the proposer approved their own menu change';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    IF (SELECT status FROM public.menu_change_requests WHERE id = v_own) <> 'pending' THEN
        RAISE EXCEPTION 'the refused decision still changed the request';
    END IF;

    RAISE NOTICE 'OK 6: a proposer cannot decide their own request';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. The owner approves the kitchen's request, and the menu changes.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_request uuid;
    v_item    uuid;
    v_price   numeric;
BEGIN
    SELECT id INTO v_request FROM public.menu_change_requests
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND proposed_name = 'كبدة إسكندراني' AND status = 'pending';
    IF v_request IS NULL THEN
        RAISE EXCEPTION 'the kitchen request is missing';
    END IF;

    v_item := app.decide_menu_change(v_request, true, 'موافق، بسعر البداية');

    SELECT price INTO v_price FROM public.sellable_items WHERE id = v_item;
    IF v_price <> 65.00 THEN
        RAISE EXCEPTION 'the approved price was not applied (got %)', v_price;
    END IF;

    IF (SELECT status FROM public.menu_change_requests WHERE id = v_request) <> 'approved' THEN
        RAISE EXCEPTION 'the dish was created but the request was not marked approved';
    END IF;

    -- The decision and the change are one transaction; the request now points
    -- at the dish it produced.
    IF (SELECT sellable_item_id FROM public.menu_change_requests WHERE id = v_request)
       IS DISTINCT FROM v_item THEN
        RAISE EXCEPTION 'the approved request does not point at the dish it created';
    END IF;

    RAISE NOTICE 'OK 7: approval created the dish and recorded the decision';
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. A settled request cannot be decided twice.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_request uuid;
BEGIN
    SELECT id INTO v_request FROM public.menu_change_requests
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
       AND status = 'approved' LIMIT 1;

    BEGIN
        PERFORM app.decide_menu_change(v_request, false, 'غيّرت رأيي');
        RAISE EXCEPTION 'an approved request was decided a second time';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;
    RAISE NOTICE 'OK 8: a decision is final';
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. Retiring takes the dish off the till and leaves the history alone.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_item    uuid;
    v_request uuid;
BEGIN
    SELECT id INTO v_item FROM public.sellable_items
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000' AND is_active
     ORDER BY created_at LIMIT 1;

    INSERT INTO public.menu_change_requests
        (organization_id, kind, sellable_item_id, reason, requested_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'retire', v_item,
            'توقّف المورّد عن توفير المكوّن الأساسي',
            'f10c0002-0000-4000-8000-000000000002')
    RETURNING id INTO v_request;

    PERFORM set_config('app.current_user_id', 'f10c0004-0000-4000-8000-000000000004', true);
    PERFORM app.decide_menu_change(v_request, true, NULL);

    IF (SELECT is_active FROM public.sellable_items WHERE id = v_item) THEN
        RAISE EXCEPTION 'the retired dish is still on the menu';
    END IF;

    -- Retired, not deleted: the row survives so every order that sold it still
    -- resolves to a name and a captured cost.
    IF NOT EXISTS (SELECT FROM public.sellable_items WHERE id = v_item) THEN
        RAISE EXCEPTION 'retiring deleted the dish and took its history with it';
    END IF;

    RAISE NOTICE 'OK 9: retiring flags the dish and keeps the record';
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. Withdrawing your own request; and not somebody else's.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0005-0000-4000-8000-000000000005';

DO $$
DECLARE
    v_own uuid;
BEGIN
    SELECT id INTO v_own FROM public.menu_change_requests
     WHERE requested_by = 'f10c0005-0000-4000-8000-000000000005' AND status = 'pending' LIMIT 1;

    UPDATE public.menu_change_requests
       SET status = 'withdrawn', decided_at = now()
     WHERE id = v_own;

    IF (SELECT status FROM public.menu_change_requests WHERE id = v_own) <> 'withdrawn' THEN
        RAISE EXCEPTION 'a proposer could not withdraw their own request';
    END IF;
    RAISE NOTICE 'OK 10: a proposer can withdraw their own request';
END;
$$;

SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_other uuid;
BEGIN
    -- The kitchen files one, the OWNER's is what it tries to withdraw.
    INSERT INTO public.menu_change_requests
        (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'create', 'طبق ثانٍ', 40,
            'اقتراح إضافي', 'f10c0002-0000-4000-8000-000000000002');

    SELECT id INTO v_other FROM public.menu_change_requests
     WHERE requested_by <> 'f10c0002-0000-4000-8000-000000000002'
       AND status = 'pending' LIMIT 1;

    IF v_other IS NOT NULL THEN
        UPDATE public.menu_change_requests
           SET status = 'withdrawn', decided_at = now()
         WHERE id = v_other;

        IF (SELECT status FROM public.menu_change_requests WHERE id = v_other) = 'withdrawn' THEN
            RAISE EXCEPTION 'somebody withdrew another person''s request';
        END IF;
    END IF;

    RAISE NOTICE 'OK 10b: a request can only be withdrawn by its author';
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. Cross-tenant: another restaurant's request is invisible and undecidable.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    -- Seeded with a literal id by floor_roles_fixture, because RLS hides it
    -- from this connection and a lookup would return NULL.
    v_foreign uuid := '0e17e400-000f-400f-800f-00000000000f';
    v_seen    int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.menu_change_requests WHERE id = v_foreign;
    IF v_seen <> 0 THEN
        RAISE EXCEPTION 'another restaurant''s menu request is visible';
    END IF;

    BEGIN
        PERFORM app.decide_menu_change(v_foreign, true, NULL);
        RAISE EXCEPTION 'our owner decided another restaurant''s menu change';
    EXCEPTION WHEN no_data_found THEN
        NULL;
    END;

    RAISE NOTICE 'OK 11: another restaurant''s queue is out of reach';
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. THE EXCEPTION, stated and tested: a restaurant with ONE approver.
--
--     The two-person rule would otherwise lock a single-owner branch out of its
--     own menu, which is not strictness. The row still records that the same
--     person proposed and decided, so the exception is visible in the history
--     rather than hidden by it.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0006-0000-4000-8000-000000000006';

DO $$
DECLARE
    v_own  uuid;
    v_item uuid;
BEGIN
    INSERT INTO public.menu_change_requests
        (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
    VALUES ('f10c1000-0000-4000-8000-000000000000', 'create', 'طبق المالك الوحيد', 45,
            'مطعم بمالك واحد ولا يوجد من يوافق غيره',
            'f10c0006-0000-4000-8000-000000000006')
    RETURNING id INTO v_own;

    v_item := app.decide_menu_change(v_own, true, NULL);

    IF v_item IS NULL THEN
        RAISE EXCEPTION 'the only approver in the restaurant could not approve anything';
    END IF;

    -- Both roles recorded on the same row, deliberately.
    IF (SELECT decided_by FROM public.menu_change_requests WHERE id = v_own)
       IS DISTINCT FROM 'f10c0006-0000-4000-8000-000000000006' THEN
        RAISE EXCEPTION 'the self-decision was not attributed';
    END IF;

    RAISE NOTICE 'OK 12: a lone approver may decide their own request, on the record';
END;
$$;

\echo 'menu_change_verification: all checks passed'
