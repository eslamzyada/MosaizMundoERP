-- ============================================================================
-- Verification: per-tenant modules (0037)
--
-- Runs as mosaiz_app_user. Identities from floor_roles_fixture.sql:
--
--   f10c0000 organization    f10c0004 owner       f10c0005 regional manager
--   f10c0003 branch manager  f10c0002 kitchen     f10c0001 waiter
--
-- The claims worth proving are not "the toggle works". They are:
--
--   1. Switching a module off refuses new work IN THE DATABASE — not in a
--      sidebar a client can ignore.
--   2. Switching it off does NOT hide what already happened. This is the one
--      that would make the books lie, and it is asserted by counting the same
--      rows before and after.
--   3. Nobody below an owner decides what the restaurant pays for.
--   4. The system cannot be left in a shape that cannot work: no purchasing
--      without an inventory to purchase into.
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
-- 1. A tenant with no rows of its own still runs everything.
--
--    The fallback matters more than it looks: a module added in a future
--    migration must not switch itself off for every existing restaurant on the
--    morning it ships.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT app.org_has_module('f10c0000-0000-4000-8000-000000000000', 'purchasing') THEN
        RAISE EXCEPTION 'a tenant that never chose is not running purchasing';
    END IF;
    IF app.org_has_module('f10c0000-0000-4000-8000-000000000000', 'no_such_module') THEN
        RAISE EXCEPTION 'an unknown module reads as enabled';
    END IF;
    RAISE NOTICE 'OK 1: unset means the catalogue default, and an unknown module is off';
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. Only an owner or a regional manager decides what the restaurant runs.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0003-0000-4000-8000-000000000003';

DO $$
BEGIN
    BEGIN
        PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'purchasing', false);
        RAISE EXCEPTION 'a branch manager switched off a module';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'OK 2: a branch manager cannot change the subscription';
END;
$$;

SET app.current_user_id = 'f10c0002-0000-4000-8000-000000000002';

DO $$
BEGIN
    BEGIN
        PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'printers', false);
        RAISE EXCEPTION 'the kitchen switched off a module';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'OK 2b: neither can the kitchen';
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. THE ONE THAT MATTERS: off stops new work and changes no history.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_before  int;
    v_after   int;
    v_touched int;
BEGIN
    -- Something to have history OF. Without this the count-is-unchanged
    -- assertion below would be 0 = 0 and would prove nothing.
    INSERT INTO public.suppliers (organization_id, name, phone)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'مورّد ما قبل الإيقاف', '0100000000');

    SELECT count(*) INTO v_before FROM public.suppliers
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_before = 0 THEN
        RAISE EXCEPTION 'no suppliers to be history of — the next assertion would be vacuous';
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'purchasing', false);

    -- New work is refused. By the database.
    BEGIN
        INSERT INTO public.suppliers (organization_id, name)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'مورّد بعد الإيقاف');
        RAISE EXCEPTION 'a supplier was created while purchasing was switched off';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- ...and editing an existing one reaches nothing, or "off" would only mean
    -- "no new rows" while every old row stayed editable.
    --
    -- This one does NOT raise, and that difference is worth stating: a
    -- RESTRICTIVE policy's USING clause FILTERS the rows an UPDATE can see,
    -- while its WITH CHECK REJECTS the row an INSERT proposes. So the insert
    -- above throws and this matches zero rows. The assertion has to be about
    -- the effect, or it would be asserting the wrong mechanism.
    UPDATE public.suppliers SET name = 'اسم جديد'
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    GET DIAGNOSTICS v_touched = ROW_COUNT;
    IF v_touched <> 0 THEN
        RAISE EXCEPTION 'edited % suppliers while purchasing was switched off', v_touched;
    END IF;

    IF NOT EXISTS (SELECT FROM public.suppliers
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                      AND name = 'مورّد ما قبل الإيقاف') THEN
        RAISE EXCEPTION 'the supplier was renamed despite matching no rows';
    END IF;

    -- But the history reads exactly as it did.
    SELECT count(*) INTO v_after FROM public.suppliers
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    IF v_after <> v_before THEN
        RAISE EXCEPTION
            'switching purchasing off changed the past: % suppliers became %',
            v_before, v_after;
    END IF;

    RAISE NOTICE 'OK 3: writes refused, % suppliers still readable', v_after;
END;
$$;

-- The same claim for the reports that read across the module boundary: a
-- purchase order behind a delivered batch must still explain that batch.
DO $$
DECLARE
    v_pos int;
BEGIN
    SELECT count(*) INTO v_pos FROM public.purchase_orders
     WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
    -- No exception, no filtering: SELECT was never gated. The assertion is
    -- that this statement runs at all while the module is off.
    RAISE NOTICE 'OK 3b: purchase orders still readable with purchasing off (%)', v_pos;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A tenant cannot be left in an impossible shape.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    -- inventory is still on, and recipes/stocktake/waste still depend on it.
    BEGIN
        PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'inventory', false);
        RAISE EXCEPTION 'inventory was switched off while its dependents were still on';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    -- Turn the dependents off, and then it is allowed.
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'recipes',   false);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'stocktake', false);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'waste',     false);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'inventory', false);

    -- And now the reverse: purchasing cannot come back before inventory does.
    BEGIN
        PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'purchasing', true);
        RAISE EXCEPTION 'purchasing was switched on with no inventory to purchase into';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    RAISE NOTICE 'OK 4: dependencies hold in both directions';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. The write gate follows the module, not the role.
--
--    The owner passes every role check in 0010. What stops this is the module.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO public.raw_inventory_items
            (organization_id, name, unit_of_measure)
        VALUES ('f10c0000-0000-4000-8000-000000000000', 'دقيق للاختبار', 'kg');
        RAISE EXCEPTION 'the owner added stock while inventory was switched off';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    RAISE NOTICE 'OK 5: the highest role does not outrank the subscription';
END;
$$;

-- Put it back, in dependency order, and prove the refusal was the module by
-- doing the identical INSERT again.
DO $$
BEGIN
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'inventory',  true);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'recipes',    true);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'stocktake',  true);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'waste',      true);
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'purchasing', true);

    INSERT INTO public.raw_inventory_items
        (organization_id, name, unit_of_measure)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'دقيق للاختبار', 'kg');

    RAISE NOTICE 'OK 5b: the same statement succeeds once the module is back';
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. menu_approval: what a tenant switches off is the second person, never the
--    audited path.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_req uuid;
BEGIN
    -- This organization has two approvers (owner and regional manager), so the
    -- two-person rule genuinely applies — 0035 already exempts a restaurant
    -- that has only one, and testing against that exemption would prove nothing.
    IF app.menu_approver_count('f10c0000-0000-4000-8000-000000000000') < 2 THEN
        RAISE EXCEPTION 'fixture has fewer than two approvers — section 6 would be vacuous';
    END IF;

    INSERT INTO public.menu_change_requests
        (organization_id, kind, proposed_name, proposed_price, reason, requested_by)
    VALUES ('f10c0000-0000-4000-8000-000000000000', 'create', 'عصير قصب', 15,
            'المشروب الأكثر طلبًا في الصيف',
            'f10c0004-0000-4000-8000-000000000004')
    RETURNING id INTO v_req;

    -- Module ON: the owner cannot approve what the owner proposed.
    BEGIN
        PERFORM app.decide_menu_change(v_req, true, 'موافق على اقتراحي');
        RAISE EXCEPTION 'the proposer approved their own change with the cycle ON';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- Module OFF: the same person may finish the job.
    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'menu_approval', false);
    PERFORM app.decide_menu_change(v_req, true, 'مطعم بصاحب واحد');

    IF (SELECT status FROM public.menu_change_requests WHERE id = v_req) <> 'approved' THEN
        RAISE EXCEPTION 'the change was not applied with the cycle off';
    END IF;

    -- The audit trail survives: who asked, who decided, and why.
    IF (SELECT decided_by FROM public.menu_change_requests WHERE id = v_req) IS NULL
       OR (SELECT decision_note FROM public.menu_change_requests WHERE id = v_req) IS NULL THEN
        RAISE EXCEPTION 'switching the cycle off lost the record of the decision';
    END IF;

    -- And the menu really changed — the point of the whole path.
    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000'
                      AND name = 'عصير قصب') THEN
        RAISE EXCEPTION 'the approved item never reached the menu';
    END IF;

    PERFORM app.set_module('f10c0000-0000-4000-8000-000000000000', 'menu_approval', true);
    RAISE NOTICE 'OK 6: off removes the second person, not the record';
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. The catalogue is a price list: readable by everyone, writable by nobody.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_seen int;
BEGIN
    SELECT count(*) INTO v_seen FROM public.modules;
    IF v_seen = 0 THEN
        RAISE EXCEPTION 'a waiter cannot see the module catalogue';
    END IF;

    BEGIN
        INSERT INTO public.modules (key, name_ar, description_ar)
        VALUES ('rogue', 'وحدة', 'وحدة مزروعة');
        RAISE EXCEPTION 'the catalogue is writable from the application';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- That refusal is ambiguous on its own, and the ambiguity is worth naming:
    -- a missing GRANT and a row-level policy with no INSERT clause raise the
    -- SAME SQLSTATE. The block above therefore passes whether or not the
    -- privilege was ever revoked. This is the assertion that distinguishes them.
    IF has_table_privilege('mosaiz_app_user', 'public.modules', 'INSERT')
       OR has_table_privilege('mosaiz_app_user', 'public.modules', 'UPDATE')
       OR has_table_privilege('mosaiz_app_user', 'public.modules', 'DELETE') THEN
        RAISE EXCEPTION 'the application role holds a write privilege on the module catalogue';
    END IF;

    IF has_table_privilege('mosaiz_app_user', 'public.organization_modules', 'INSERT')
       OR has_table_privilege('mosaiz_app_user', 'public.organization_modules', 'UPDATE')
       OR has_table_privilege('mosaiz_app_user', 'public.organization_modules', 'DELETE') THEN
        RAISE EXCEPTION 'a subscription can be written without going through app.set_module';
    END IF;

    -- And nobody edits their own subscription directly, going around set_module.
    BEGIN
        UPDATE public.organization_modules SET enabled = true
         WHERE organization_id = 'f10c0000-0000-4000-8000-000000000000';
        RAISE EXCEPTION 'a waiter rewrote the organization''s subscription';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    RAISE NOTICE 'OK 7: % modules readable, none of them writable', v_seen;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Cross-tenant: nobody switches another restaurant's modules.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'f10c0004-0000-4000-8000-000000000004';

DO $$
BEGIN
    -- The solo restaurant from floor_roles_fixture, named as a LITERAL. Looking
    -- a foreign organization up by slug would read through RLS, find nothing,
    -- and leave this section quietly asserting against NULL.
    BEGIN
        PERFORM app.set_module('f10c1000-0000-4000-8000-000000000000', 'purchasing', false);
        RAISE EXCEPTION 'switched off a module in somebody else''s restaurant';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;

    -- And it really is still on over there — the refusal above could otherwise
    -- be hiding a write that happened before the error.
    IF NOT app.org_has_module('f10c1000-0000-4000-8000-000000000000', 'purchasing') THEN
        RAISE EXCEPTION 'the other restaurant lost a module anyway';
    END IF;

    RAISE NOTICE 'OK 8: another restaurant''s subscription is not ours to change';
END;
$$;

\echo 'module_verification: all checks passed'
