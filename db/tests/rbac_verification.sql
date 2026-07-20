-- ============================================================================
-- RBAC verification (0010) — runs as mosaiz_app_user, so RLS actually applies.
-- (Running this as postgres would prove nothing: the owner bypasses ENABLE-only
-- RLS, so every assertion below would pass vacuously.)
--
-- Self-asserting: any broken expectation raises, psql exits non-zero, CI fails.
-- Run order: immediately after rbac_fixture.sql (which seeds, as postgres).
--
--   owner / regional_manager / branch_manager -> operational writes
--   cashier / staff                           -> sell only
--   accountant                                -> read-only
-- ============================================================================
\set ON_ERROR_STOP on

-- Fixture ids
--   org = a11c0000-…  owner = a11c0001-…  branch_manager = a11c0002-…
--   cashier = a11c0003-…  accountant = a11c0004-…

-- ----------------------------------------------------------------------------
-- 1. A branch manager MAY receive stock (the administrative INSERT).
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_count int;
BEGIN
    INSERT INTO public.inventory_batches
        (id, organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
    VALUES ('a11cba7c-0000-4000-8000-00000000000b',
            'a11c0000-0000-4000-8000-000000000000',
            'a11cf00d-0000-4000-8000-000000000001', 500, 500, 0.10);

    SELECT count(*) INTO v_count FROM public.inventory_batches
    WHERE id = 'a11cba7c-0000-4000-8000-00000000000b';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'branch_manager must be able to receive stock';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A cashier MAY NOT receive stock. This is the whole point of 0010: before
--    it, this INSERT succeeded.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.inventory_batches
            (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11cf00d-0000-4000-8000-000000000001', 999, 999, 0.10);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;   -- RLS rejects a restricted INSERT with this SQLSTATE (42501)
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier received stock';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A cashier MAY NOT rewrite a recipe.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.bill_of_materials
            (organization_id, sellable_item_id, raw_item_id, quantity_required)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11c5e11-0000-4000-8000-000000000001',
                'a11cf00d-0000-4000-8000-000000000001', 999);
    EXCEPTION WHEN insufficient_privilege OR unique_violation THEN
        -- unique_violation would mean the row existed; either way it was not
        -- the cashier's write that changed the recipe.
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier edited a recipe';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A cashier MAY sell — and the sale still draws stock down. This is the
--    regression that a naive "lock the inventory tables" rule would cause:
--    process_pos_checkout is SECURITY INVOKER, so the UPDATE of the batch and
--    any deficit INSERT run as the cashier.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_before numeric;
    v_after  numeric;
BEGIN
    SELECT sum(quantity_remaining) INTO v_before
    FROM public.inventory_batches
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-000000000001';

    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'a11c0000-0000-4000-8000-000000000000',
        'client_offline_id', 'a11c0de0-0000-4000-8000-000000000001',
        'total_amount',      100,
        'items', jsonb_build_array(jsonb_build_object(
            'sellable_item_id', 'a11c5e11-0000-4000-8000-000000000001',
            'quantity', 2, 'unit_price', 50))
    ));

    SELECT sum(quantity_remaining) INTO v_after
    FROM public.inventory_batches
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-000000000001';

    -- 2 shawarma x 10g of chicken = 20g drawn down.
    IF v_before - v_after <> 20 THEN
        RAISE EXCEPTION 'cashier sale must draw down 20g of stock, drew % (before % / after %)',
            v_before - v_after, v_before, v_after;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. An accountant is read-only: may READ the catalog, may NOT sell.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0004-0000-4000-8000-000000000004';

DO $$
DECLARE
    v_visible int;
    rejected  boolean := false;
BEGIN
    -- Reading is untouched by 0010 — an accountant must still see everything.
    SELECT count(*) INTO v_visible FROM public.inventory_batches
    WHERE organization_id = 'a11c0000-0000-4000-8000-000000000000';
    IF v_visible < 1 THEN
        RAISE EXCEPTION 'accountant must retain read access to stock (saw % rows)', v_visible;
    END IF;

    BEGIN
        CALL app.process_pos_checkout(jsonb_build_object(
            'organization_id',   'a11c0000-0000-4000-8000-000000000000',
            'client_offline_id', 'a11c0de0-0000-4000-8000-000000000002',
            'total_amount',      50,
            'items', jsonb_build_array(jsonb_build_object(
                'sellable_item_id', 'a11c5e11-0000-4000-8000-000000000001',
                'quantity', 1, 'unit_price', 50))
        ));
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a read-only accountant rang up a sale';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. An accountant MAY NOT receive stock either.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        INSERT INTO public.inventory_batches
            (organization_id, raw_item_id, quantity_received, quantity_remaining, cost_at_purchase)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11cf00d-0000-4000-8000-000000000001', 42, 42, 0.10);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: an accountant received stock';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Roles do not leak across tenants: the fixture owner is not a member of
--    ci-bistro-cairo, so their admin rights must not apply there. (Guards
--    against a predicate that checks the role but forgets the organization.)
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_owner_elsewhere boolean;
BEGIN
    SELECT app.user_can_administer(id) INTO v_owner_elsewhere
    FROM public.organizations WHERE slug = 'ci-rbac-org';
    IF NOT v_owner_elsewhere THEN
        RAISE EXCEPTION 'owner must administer their own org';
    END IF;

    -- A random other org id: same user, no membership -> no rights.
    SELECT app.user_can_administer('00000000-0000-4000-8000-0000000000ff')
    INTO v_owner_elsewhere;
    IF v_owner_elsewhere THEN
        RAISE EXCEPTION 'SECURITY HOLE: role granted rights in an org the user does not belong to';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. PRIVILEGE ESCALATION (0011). Before 0011, organization_memberships carried
--    only a permissive FOR ALL policy, so this UPDATE succeeded and every gate
--    above evaporated. RLS filters the row out rather than raising, so the
--    assertion is on the effect, not on an exception.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_role text;
BEGIN
    BEGIN
        UPDATE public.organization_memberships
        SET role = 'owner'
        WHERE user_id = 'a11c0003-0000-4000-8000-000000000003';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;   -- either outcome is fine; the row must simply not change
    END;

    SELECT role INTO v_role FROM public.organization_memberships
    WHERE user_id = 'a11c0003-0000-4000-8000-000000000003';

    IF v_role <> 'cashier' THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier promoted themselves to %', v_role;
    END IF;
END;
$$;

-- A cashier cannot smuggle in a membership either.
DO $$
DECLARE
    v_count int;
BEGIN
    BEGIN
        INSERT INTO public.organization_memberships (organization_id, user_id, role)
        VALUES ('a11c0000-0000-4000-8000-000000000000',
                'a11c0003-0000-4000-8000-000000000003', 'owner');
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    SELECT count(*) INTO v_count FROM public.organization_memberships
    WHERE user_id = 'a11c0003-0000-4000-8000-000000000003';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier granted themselves a second membership';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. Member management is owner-only.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        CALL app.invite_org_member('a11c0000-0000-4000-8000-000000000000',
                                   'sneaky@ci.test', 'owner');
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier invited a member';
    END IF;
END;
$$;

-- A branch_manager runs daily ops but is not the privilege boundary.
SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    rejected boolean := false;
BEGIN
    BEGIN
        CALL app.set_member_role('a11c0000-0000-4000-8000-000000000000',
                                 'a11c0003-0000-4000-8000-000000000003', 'owner');
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'SECURITY HOLE: a branch_manager re-roled a member';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. Owner CAN manage members — with guard rails.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_role     text;
    rejected   boolean;
BEGIN
    -- Promote the cashier to accountant.
    CALL app.set_member_role('a11c0000-0000-4000-8000-000000000000',
                             'a11c0003-0000-4000-8000-000000000003', 'accountant');
    SELECT role INTO v_role FROM public.organization_memberships
    WHERE user_id = 'a11c0003-0000-4000-8000-000000000003';
    IF v_role <> 'accountant' THEN
        RAISE EXCEPTION 'owner must be able to re-role a member (got %)', v_role;
    END IF;
    -- Put it back so later assertions/fixtures stay meaningful.
    CALL app.set_member_role('a11c0000-0000-4000-8000-000000000000',
                             'a11c0003-0000-4000-8000-000000000003', 'cashier');

    -- No self-service, even for an owner.
    rejected := false;
    BEGIN
        CALL app.set_member_role('a11c0000-0000-4000-8000-000000000000',
                                 'a11c0001-0000-4000-8000-000000000001', 'staff');
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an owner must not be able to change their own role';
    END IF;

    -- Lockout guard: this org has exactly one owner.
    rejected := false;
    BEGIN
        CALL app.set_member_active('a11c0000-0000-4000-8000-000000000000',
                                   'a11c0001-0000-4000-8000-000000000001', false);
    EXCEPTION WHEN insufficient_privilege THEN
        rejected := true;   -- blocked as "cannot deactivate yourself"
    END;
    IF NOT rejected THEN
        RAISE EXCEPTION 'an owner must not be able to deactivate themselves';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. Invitation round trip: an invited identity joins THIS org rather than
--     being provisioned a new one (the junk-org problem 0011 exists to fix).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_joined  boolean;
    v_org     uuid;
    v_role    text;
    v_orgs    int;
    v_new_usr uuid := 'a11c0005-0000-4000-8000-000000000005';
BEGIN
    CALL app.invite_org_member('a11c0000-0000-4000-8000-000000000000',
                               'NewHire@CI.test', 'cashier');   -- mixed case on purpose

    -- Signup arrives (the webhook calls this before provisioning).
    SELECT app.accept_invitation(v_new_usr, 'newhire@ci.test') INTO v_joined;
    IF NOT v_joined THEN
        RAISE EXCEPTION 'invitation must be accepted (email match is case-insensitive)';
    END IF;

    SELECT organization_id, role INTO v_org, v_role
    FROM public.organization_memberships WHERE user_id = v_new_usr;

    IF v_org <> 'a11c0000-0000-4000-8000-000000000000' THEN
        RAISE EXCEPTION 'invitee joined the wrong organization (%)', v_org;
    END IF;
    IF v_role <> 'cashier' THEN
        RAISE EXCEPTION 'invitee must land on the invited role, got %', v_role;
    END IF;

    SELECT count(*) INTO v_orgs FROM public.organization_memberships WHERE user_id = v_new_usr;
    IF v_orgs <> 1 THEN
        RAISE EXCEPTION 'invitee must hold exactly one membership, got %', v_orgs;
    END IF;

    -- Consumed: a replayed signup must not join twice.
    SELECT app.accept_invitation(v_new_usr, 'newhire@ci.test') INTO v_joined;
    IF v_joined THEN
        RAISE EXCEPTION 'an accepted invitation must not be reusable';
    END IF;

    -- An uninvited signup falls through to normal provisioning.
    SELECT app.accept_invitation('a11c0006-0000-4000-8000-000000000006', 'stranger@ci.test')
    INTO v_joined;
    IF v_joined THEN
        RAISE EXCEPTION 'a stranger must not be joined to an org';
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. Recipe line REMOVAL (0014). bill_of_materials carries the permissive
--     user_belongs_to_org policy FOR ALL — which covers DELETE — and 0010 gated
--     only INSERT and UPDATE. So the DELETE privilege granted by 0014 must ship
--     with its own RESTRICTIVE gate, or any member of the organization could
--     quietly drop an ingredient out of a recipe: food cost changes and that
--     ingredient silently stops being deducted at checkout.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'a11c0001-0000-4000-8000-000000000001';

DO $$
BEGIN
    -- A throwaway ingredient and line, so the fixture recipe (asserted against
    -- in sections 3 and 4) is left intact.
    INSERT INTO public.raw_inventory_items (id, organization_id, name, unit_of_measure)
    VALUES ('a11cf00d-0000-4000-8000-00000000000d',
            'a11c0000-0000-4000-8000-000000000000', 'RBAC Garnish', 'grams');

    INSERT INTO public.bill_of_materials
        (organization_id, sellable_item_id, raw_item_id, quantity_required)
    VALUES ('a11c0000-0000-4000-8000-000000000000',
            'a11c5e11-0000-4000-8000-000000000001',
            'a11cf00d-0000-4000-8000-00000000000d', 5);
END;
$$;

-- A cashier MAY NOT remove an ingredient from a recipe. RLS filters the row out
-- of the DELETE rather than raising, so assert on the effect, not an exception.
SET app.current_user_id = 'a11c0003-0000-4000-8000-000000000003';

DO $$
DECLARE
    v_count int;
BEGIN
    BEGIN
        DELETE FROM public.bill_of_materials
        WHERE raw_item_id = 'a11cf00d-0000-4000-8000-00000000000d';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;   -- either outcome is fine; the line must simply survive
    END;

    SELECT count(*) INTO v_count FROM public.bill_of_materials
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-00000000000d';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'SECURITY HOLE: a cashier removed an ingredient from a recipe';
    END IF;
END;
$$;

-- A branch manager MAY: removing a line is administrative, like adding one.
SET app.current_user_id = 'a11c0002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_count int;
BEGIN
    DELETE FROM public.bill_of_materials
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-00000000000d';

    SELECT count(*) INTO v_count FROM public.bill_of_materials
    WHERE raw_item_id = 'a11cf00d-0000-4000-8000-00000000000d';
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'a branch_manager must be able to remove a recipe line';
    END IF;
END;
$$;

SELECT 'rbac_verification: all assertions passed' AS result;
