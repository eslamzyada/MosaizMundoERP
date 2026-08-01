-- ============================================================================
-- Migration 0035: The menu stops being editable
-- Mosaiz Mundo ERP
--
-- Until now a branch manager could rename a dish or re-price it in two clicks,
-- and the price they typed became the price the till charges — immediately,
-- with nobody else involved. For a restaurant that is the wrong shape. The menu
-- is a published document: the kitchen has to be able to cook it, the owner has
-- to be willing to sell it at that price, and neither of them should discover a
-- change by finding it on a receipt.
--
-- So a change becomes a REQUEST, and the request needs a second person.
--
-- ----------------------------------------------------------------------------
-- WHERE THE STRICTNESS ACTUALLY LIVES.
--
-- Not in the API, and not in a role check. The app role LOSES INSERT and UPDATE
-- on sellable_items entirely. After this migration there is no statement the
-- application can issue that changes a menu item — the privilege is gone, so a
-- bug, a new endpoint, a forgotten requireRole, or somebody with a psql prompt
-- and the app credentials all fail the same way.
--
-- The only write path left is app.decide_menu_change(), which is SECURITY
-- DEFINER, runs as the owner, and will not act unless a pending request exists
-- and the caller is allowed to decide it. That is what makes this a cycle
-- rather than a convention.
--
-- ----------------------------------------------------------------------------
-- THE TWO-PERSON RULE, AND ITS ONE EXCEPTION.
--
-- The decider must not be the proposer. That is the whole point: "the kitchen
-- asked and the owner agreed" is a different fact from "the owner changed it".
--
-- The exception is a restaurant with exactly one person who can approve. A
-- single-owner branch would otherwise be unable to change its own menu, which
-- is not strictness, it is a locked door. In that case they may decide their own
-- request — and the row still records that they were both proposer and decider,
-- so the exception is visible in the history rather than hidden by it.
--
-- ----------------------------------------------------------------------------
-- WHO IS INVOLVED.
--
--   proposing  kitchen, branch_manager, regional_manager, owner
--              — the people who know whether a dish can be cooked and sold.
--   deciding   regional_manager, owner
--              — "مدير إقليمي أو المالك", as asked for.
--
-- A waiter, cashier, accountant or staff member can READ the queue and cannot
-- touch it. Reading is deliberate: a waiter should be able to see that the
-- price they are quoting is about to change.
--
-- Depends on: 0010 (role helpers), 0034 (waiter/kitchen roles)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. A dish can leave the menu without leaving the books.
--
--    Retiring has to be a flag, not a delete: every order_item ever sold points
--    at the dish, and its captured cost is why last quarter's margin can still
--    be explained. Deleting it would either fail on the foreign key or, worse,
--    take the history with it.
--
--    The till's menu query is narrowed to match in the same release — a flag
--    nothing filters on is a retire button that does nothing.
-- ----------------------------------------------------------------------------
ALTER TABLE public.sellable_items
    ADD COLUMN is_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.sellable_items.is_active IS
    'False once the dish has been retired through an approved menu change (0035). Never deleted: the orders that sold it still point at it.';

CREATE INDEX sellable_items_active_idx
    ON public.sellable_items (organization_id, is_active);

-- ----------------------------------------------------------------------------
-- 1. Who may propose, and who may decide.
--
--    Separate helpers rather than inlining the role lists in a policy, so the
--    API and the database cannot disagree about who is who.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.user_can_propose_menu(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.organization_memberships m
         WHERE m.organization_id = p_organization_id
           AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
           AND m.is_active
           AND m.role IN ('kitchen', 'branch_manager', 'regional_manager', 'owner')
    );
$$;

CREATE FUNCTION app.user_can_decide_menu(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.organization_memberships m
         WHERE m.organization_id = p_organization_id
           AND m.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
           AND m.is_active
           AND m.role IN ('regional_manager', 'owner')
    );
$$;

/** How many people in this organization could approve a menu change at all. */
CREATE FUNCTION app.menu_approver_count(p_organization_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT count(*)::int FROM public.organization_memberships m
     WHERE m.organization_id = p_organization_id
       AND m.is_active
       AND m.role IN ('regional_manager', 'owner');
$$;

REVOKE EXECUTE ON FUNCTION app.user_can_propose_menu(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.user_can_decide_menu(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.menu_approver_count(uuid) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        -- The policies below call these, and a policy runs as the querying
        -- role, so the app role must be able to execute them.
        GRANT EXECUTE ON FUNCTION app.user_can_propose_menu(uuid) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.user_can_decide_menu(uuid) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.menu_approver_count(uuid) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. The request.
--
--    The proposed values are explicit columns rather than a jsonb blob: a blob
--    cannot be constrained, so a proposal with a negative price would sit in the
--    queue looking valid until the moment somebody approved it and the CHECK on
--    sellable_items refused. The proposal is checked when it is WRITTEN.
-- ----------------------------------------------------------------------------
CREATE TABLE public.menu_change_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- create = a new dish, update = rename/re-price/re-sku, retire = take it off
    -- the menu. Retire is a separate kind from update because it is the one that
    -- changes what a customer can order tonight.
    kind            text NOT NULL CHECK (kind IN ('create', 'update', 'retire')),

    -- Null for a create. NO ACTION: a request is a record of what was asked,
    -- and it does not stop having been asked because the dish was later removed.
    sellable_item_id uuid,

    -- What is being asked for. Null means "leave this alone" on an update.
    proposed_name   text CHECK (proposed_name IS NULL
                                OR char_length(btrim(proposed_name)) BETWEEN 1 AND 120),
    proposed_sku    text CHECK (proposed_sku IS NULL
                                OR char_length(btrim(proposed_sku)) BETWEEN 1 AND 60),
    proposed_price  numeric(10,2) CHECK (proposed_price IS NULL OR proposed_price >= 0),

    -- Why. Not optional on purpose: "the price went up" is the part a decision
    -- is actually made on, and a queue of unexplained changes is a queue nobody
    -- reads.
    reason          text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),

    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),

    requested_by    uuid NOT NULL REFERENCES public.users (id),
    requested_at    timestamptz NOT NULL DEFAULT now(),

    decided_by      uuid REFERENCES public.users (id),
    decided_at      timestamptz,
    decision_note   text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- A create names a new dish, so it needs a name and a price and must not
    -- point at an existing item — WHILE IT IS STILL A PROPOSAL. Once approved it
    -- points at the dish it produced, which is how "what did this request
    -- actually do" stays answerable a year later. Writing the rule without that
    -- exception makes the procedure unable to record its own result.
    CONSTRAINT menu_change_shape CHECK (
        (kind = 'create' AND proposed_name IS NOT NULL AND proposed_price IS NOT NULL
                         AND (status = 'approved' OR sellable_item_id IS NULL))
     OR (kind = 'update' AND sellable_item_id IS NOT NULL
                         AND (proposed_name IS NOT NULL OR proposed_sku IS NOT NULL
                              OR proposed_price IS NOT NULL))
     OR (kind = 'retire' AND sellable_item_id IS NOT NULL)
    ),

    -- A decision has an author and a time, or the request is still open. Half a
    -- decision is how an audit trail becomes unreadable.
    CONSTRAINT menu_change_decision_complete CHECK (
        (status = 'pending'   AND decided_by IS NULL AND decided_at IS NULL)
     OR (status = 'withdrawn' AND decided_at IS NOT NULL)
     OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    ),

    CONSTRAINT menu_change_item_org FOREIGN KEY (sellable_item_id, organization_id)
        REFERENCES public.sellable_items (id, organization_id) ON DELETE NO ACTION
);

COMMENT ON TABLE public.menu_change_requests IS
    'A proposed change to the menu, and its decision (0035). The menu cannot be changed any other way: the app role has no INSERT or UPDATE on sellable_items, so app.decide_menu_change is the only remaining write path.';

CREATE TRIGGER trg_menu_change_requests_updated_at
    BEFORE UPDATE ON public.menu_change_requests
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- The queue read ("what is waiting for me") and the item's history.
CREATE INDEX menu_change_requests_pending_idx
    ON public.menu_change_requests (organization_id, status, requested_at DESC);
CREATE INDEX menu_change_requests_item_idx
    ON public.menu_change_requests (sellable_item_id, requested_at DESC);
CREATE INDEX menu_change_requests_requested_by_idx
    ON public.menu_change_requests (requested_by);
CREATE INDEX menu_change_requests_decided_by_idx
    ON public.menu_change_requests (decided_by);

-- ----------------------------------------------------------------------------
-- 3. Isolation and gates.
-- ----------------------------------------------------------------------------
ALTER TABLE public.menu_change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.menu_change_requests
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Anyone in the organization may READ the queue. A waiter quoting tonight's
-- price should be able to see that it is about to change.
CREATE POLICY require_proposer_insert ON public.menu_change_requests
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_propose_menu(organization_id)
                AND requested_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                AND status = 'pending');

-- UPDATE is for withdrawing your own request, and nothing else. Deciding goes
-- through the procedure, which needs privileges this policy does not grant.
CREATE POLICY require_own_withdrawal ON public.menu_change_requests
    AS RESTRICTIVE FOR UPDATE
    USING      (requested_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                AND status = 'pending')
    WITH CHECK (requested_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid
                AND status = 'withdrawn');

-- No DELETE policy and no DELETE grant: a request that was made is part of the
-- record. Withdrawing is the supported way to take one back, and it leaves a
-- row behind saying so.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON public.menu_change_requests TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. THE POINT OF THE MIGRATION: the menu becomes unwritable.
--
--    Everything above is bookkeeping until this runs. With INSERT and UPDATE
--    revoked there is no statement the application can issue that changes a
--    menu item, whatever its role checks say and whatever a future endpoint
--    forgets. SELECT stays — the till has to read the menu to sell from it.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        REVOKE INSERT, UPDATE ON public.sellable_items FROM mosaiz_app_user;
    END IF;
END;
$$;

COMMENT ON TABLE public.sellable_items IS
    'The menu. NOT writable by the application role since 0035 — every change goes through a menu_change_request and app.decide_menu_change(). The 0010 admin policies remain for defence in depth, but the privilege is what actually stops a write.';

-- ----------------------------------------------------------------------------
-- 5. The only door left.
--
--    SECURITY DEFINER because it has to do what the caller cannot: write to
--    sellable_items. Every check it makes is therefore its own responsibility,
--    and they are made in order of what they protect.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.decide_menu_change(
    p_request_id uuid,
    p_approve    boolean,
    p_note       text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller    uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_request   public.menu_change_requests;
    v_item_id   uuid;
    v_approvers int;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'no authenticated user' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_request FROM public.menu_change_requests WHERE id = p_request_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'menu change request not found'
            USING ERRCODE = 'no_data_found';                       -- P0002
    END IF;

    -- Belonging first: everything after this leaks the existence of a row in
    -- another restaurant if it runs before.
    IF NOT app.user_belongs_to_org(v_request.organization_id) THEN
        RAISE EXCEPTION 'menu change request not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    IF NOT app.user_can_decide_menu(v_request.organization_id) THEN
        RAISE EXCEPTION 'deciding a menu change is limited to the owner or a regional manager'
            USING ERRCODE = 'insufficient_privilege';              -- 42501
    END IF;

    IF v_request.status <> 'pending' THEN
        RAISE EXCEPTION 'this request was already %', v_request.status
            USING ERRCODE = 'object_not_in_prerequisite_state';    -- 55000
    END IF;

    -- The two-person rule, and its one exception: a restaurant with a single
    -- approver would otherwise be locked out of its own menu.
    IF v_request.requested_by = v_caller THEN
        v_approvers := app.menu_approver_count(v_request.organization_id);
        IF v_approvers > 1 THEN
            RAISE EXCEPTION
                'a menu change must be decided by somebody other than the person who proposed it'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    IF NOT p_approve THEN
        UPDATE public.menu_change_requests
           SET status = 'rejected', decided_by = v_caller,
               decided_at = now(), decision_note = p_note
         WHERE id = p_request_id;
        RETURN NULL;
    END IF;

    -- Approved: apply it, in the same transaction as the decision. A decision
    -- recorded without the change, or a change without the decision, is the
    -- pair of states this must never leave behind.
    IF v_request.kind = 'create' THEN
        INSERT INTO public.sellable_items (organization_id, name, sku, price)
        VALUES (v_request.organization_id,
                btrim(v_request.proposed_name),
                NULLIF(btrim(coalesce(v_request.proposed_sku, '')), ''),
                v_request.proposed_price)
        RETURNING id INTO v_item_id;

    ELSIF v_request.kind = 'update' THEN
        UPDATE public.sellable_items
           SET name  = coalesce(btrim(v_request.proposed_name), name),
               sku   = CASE WHEN v_request.proposed_sku IS NULL THEN sku
                            ELSE NULLIF(btrim(v_request.proposed_sku), '') END,
               price = coalesce(v_request.proposed_price, price)
         WHERE id = v_request.sellable_item_id
           AND organization_id = v_request.organization_id
        RETURNING id INTO v_item_id;

        IF v_item_id IS NULL THEN
            RAISE EXCEPTION 'the item this request refers to no longer exists'
                USING ERRCODE = 'no_data_found';
        END IF;

    ELSE  -- retire
        UPDATE public.sellable_items
           SET is_active = false
         WHERE id = v_request.sellable_item_id
           AND organization_id = v_request.organization_id
        RETURNING id INTO v_item_id;

        IF v_item_id IS NULL THEN
            RAISE EXCEPTION 'the item this request refers to no longer exists'
                USING ERRCODE = 'no_data_found';
        END IF;
    END IF;

    UPDATE public.menu_change_requests
       SET status = 'approved', decided_by = v_caller,
           decided_at = now(), decision_note = p_note,
           sellable_item_id = coalesce(sellable_item_id, v_item_id)
     WHERE id = p_request_id;

    RETURN v_item_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.decide_menu_change(uuid, boolean, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.decide_menu_change(uuid, boolean, text) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMENT ON FUNCTION app.decide_menu_change(uuid, boolean, text) IS
    'The only remaining write path to the menu (0035). Applies an approved change and records the decision in one transaction, refusing a caller who cannot decide, a request already settled, and — unless they are the only approver in the organization — the person who proposed it.';

COMMIT;
