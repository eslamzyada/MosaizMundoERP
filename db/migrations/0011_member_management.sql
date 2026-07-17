-- ============================================================================
-- Migration 0011: Member management (and closing the escalation hole)
-- Mosaiz Mundo ERP
--
-- Two problems, one root cause: nothing owned writes to organization_memberships.
--
-- 1. PRIVILEGE ESCALATION (security fix).
--    organization_memberships carried only `user_belongs_to_org` FOR ALL, and
--    the app role holds INSERT/UPDATE/DELETE on it. Any member could therefore
--    run
--        UPDATE organization_memberships SET role='owner' WHERE user_id=<self>;
--    and 0010's role gates evaporated. Verified against the running database
--    before writing this. Not reachable through the API today (no endpoint
--    writes memberships) — but it is exactly the barrier 0010 leans on, and the
--    member-management endpoints below would have made it reachable.
--    docs/rls_policies.md already says identity-adjacent tables are
--    deny-by-default through SECURITY DEFINER procedures; this makes
--    organization_memberships actually behave that way.
--
-- 2. NO WAY TO ADD STAFF.
--    Memberships were only ever created by provision_new_tenant, which always
--    creates a NEW org with the signer-up as its owner. A cashier who signed up
--    got their own empty restaurant instead of joining yours — and because
--    /api/me resolves the EARLIEST membership, adding them afterwards would
--    still land them in that junk org. So joining must be decided BEFORE signup:
--    an invitation the webhook honours.
--
-- Member management is OWNER-ONLY here: it is the most privilege-sensitive
-- operation in the system and the approved role matrix did not cover it.
-- Relaxing it to regional_manager later is a one-line change to
-- app.caller_may_manage_members.
--
-- Depends on: 0001 (memberships), 0003 (provision_new_tenant), 0010 (role predicates)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Close the hole. RESTRICTIVE + false = a flat "no" for direct writes that
--    ANDs with the existing permissive policy, so membership rows can only be
--    written by the SECURITY DEFINER procedures below (which run as the table
--    owner and are therefore exempt from RLS). SELECT is untouched: members can
--    still see their own team.
-- ----------------------------------------------------------------------------
CREATE POLICY no_direct_insert ON public.organization_memberships
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY no_direct_update ON public.organization_memberships
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY no_direct_delete ON public.organization_memberships
    AS RESTRICTIVE FOR DELETE USING (false);

COMMENT ON TABLE public.organization_memberships IS
    'Grants a user access to one organization. Multiple rows per user = multi-branch access. Written ONLY through app.* SECURITY DEFINER procedures (0011): a direct write would let any member rewrite their own role.';

-- ----------------------------------------------------------------------------
-- 1b. Let members see their colleagues.
--
--     users carried only `users_select_own`, so a member could read exactly one
--     identity: their own. A team roster was therefore impossible — joining
--     memberships to users returned NULL for everyone else. Widen it by exactly
--     one step: you may see an identity you share an ACTIVE org with.
--
--     Permissive, so it ORs with users_select_own (you always see yourself, even
--     with no membership). The predicate is SECURITY DEFINER to read memberships
--     without re-entering that table's own policy from inside a users policy.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.shares_org_with_caller(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_memberships mine
        JOIN public.organization_memberships theirs
          ON theirs.organization_id = mine.organization_id
        WHERE mine.user_id   = app.current_user_id()
          AND mine.is_active
          AND theirs.user_id = target_user_id
    );
$$;

COMMENT ON FUNCTION app.shares_org_with_caller(uuid) IS
    'True when the session user holds an active membership in an organization the target user also belongs to. Scopes the team roster.';

CREATE POLICY users_select_org_peers ON public.users
    FOR SELECT
    USING (app.shares_org_with_caller(id));

-- ----------------------------------------------------------------------------
-- 2. Invitations — how somebody joins an EXISTING org.
-- ----------------------------------------------------------------------------
CREATE TABLE public.organization_invitations (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    -- Stored lower-cased; the unique index below makes a pending invite per
    -- (org, email) singular.
    email            text        NOT NULL CHECK (length(trim(email)) > 0),
    role             text        NOT NULL CHECK (role = ANY (ARRAY['owner','regional_manager','branch_manager','accountant','cashier','staff'])),
    invited_by       uuid        REFERENCES public.users (id) ON DELETE SET NULL,
    accepted_at      timestamptz,
    expires_at       timestamptz NOT NULL DEFAULT now() + interval '14 days',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One OPEN invitation per address per org; accepted ones stay as history.
CREATE UNIQUE INDEX organization_invitations_pending_idx
    ON public.organization_invitations (organization_id, lower(email))
    WHERE accepted_at IS NULL;

CREATE INDEX organization_invitations_email_idx
    ON public.organization_invitations (lower(email))
    WHERE accepted_at IS NULL;

COMMENT ON TABLE public.organization_invitations IS
    'Pending invitations to join an existing org. Consumed at signup by app.accept_invitation so the invitee joins THIS org instead of being provisioned a new one.';

CREATE TRIGGER trg_organization_invitations_updated_at
    BEFORE UPDATE ON public.organization_invitations
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.organization_invitations
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Like memberships: invitations decide who gets in, so they are written only
-- through the procedures below.
CREATE POLICY no_direct_insert ON public.organization_invitations
    AS RESTRICTIVE FOR INSERT WITH CHECK (false);

CREATE POLICY no_direct_update ON public.organization_invitations
    AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- 3. Guards shared by every management procedure.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.caller_may_manage_members(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT app.user_has_org_role(target_organization_id, ARRAY['owner']);
$$;

COMMENT ON FUNCTION app.caller_may_manage_members(uuid) IS
    'Who may invite, re-role or deactivate members. Owner-only: this is the privilege boundary itself.';

-- Counts remaining active owners, so no procedure can strand an org ownerless.
CREATE OR REPLACE FUNCTION app.active_owner_count(target_organization_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT count(*)::int
    FROM public.organization_memberships m
    WHERE m.organization_id = target_organization_id
      AND m.role = 'owner'
      AND m.is_active;
$$;

-- ----------------------------------------------------------------------------
-- 4. invite_org_member — record an invitation for an email.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.invite_org_member(
    p_organization_id uuid,
    p_email           text,
    p_role            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller uuid := app.current_user_id();
BEGIN
    IF NOT app.caller_may_manage_members(p_organization_id) THEN
        RAISE EXCEPTION 'only an owner may invite members to this organization'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_email IS NULL OR length(trim(p_email)) = 0 THEN
        RAISE EXCEPTION 'an email is required to invite a member';
    END IF;

    -- Someone already in the org does not need an invitation.
    IF EXISTS (
        SELECT 1
        FROM public.organization_memberships m
        JOIN public.users u ON u.id = m.user_id
        WHERE m.organization_id = p_organization_id
          AND lower(u.email) = lower(trim(p_email))
    ) THEN
        RAISE EXCEPTION 'that person is already a member of this organization';
    END IF;

    INSERT INTO public.organization_invitations (organization_id, email, role, invited_by)
    VALUES (p_organization_id, lower(trim(p_email)), p_role, v_caller);
END;
$$;

COMMENT ON PROCEDURE app.invite_org_member(uuid, text, text) IS
    'Owner-only. Records a pending invitation; the role CHECK and the pending-unique index reject a bad role or a duplicate invite.';

-- ----------------------------------------------------------------------------
-- 5. accept_invitation — called by the signup webhook BEFORE provisioning.
--    Returns true when the new identity joined an existing org, so the caller
--    knows to skip provision_new_tenant (and not mint a junk org).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.accept_invitation(
    p_user_id uuid,
    p_email   text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_invite public.organization_invitations%ROWTYPE;
BEGIN
    SELECT * INTO v_invite
    FROM public.organization_invitations
    WHERE lower(email) = lower(trim(p_email))
      AND accepted_at IS NULL
      AND expires_at > now()
    ORDER BY created_at ASC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- The identity may not exist yet (this runs at signup).
    INSERT INTO public.users (id, email)
    VALUES (p_user_id, p_email)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.organization_memberships (organization_id, user_id, role)
    VALUES (v_invite.organization_id, p_user_id, v_invite.role)
    ON CONFLICT (organization_id, user_id) DO NOTHING;

    UPDATE public.organization_invitations
    SET accepted_at = now()
    WHERE id = v_invite.id;

    RETURN true;
END;
$$;

COMMENT ON FUNCTION app.accept_invitation(uuid, text) IS
    'Signup hook: joins an invited identity to the inviting org. True = joined, so the caller must NOT provision a new tenant.';

-- ----------------------------------------------------------------------------
-- 6. set_member_role — the operation the escalation hole used to hand out free.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.set_member_role(
    p_organization_id uuid,
    p_user_id         uuid,
    p_role            text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller       uuid := app.current_user_id();
    v_current_role text;
BEGIN
    IF NOT app.caller_may_manage_members(p_organization_id) THEN
        RAISE EXCEPTION 'only an owner may change member roles'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- No self-service. Blocks the escalation this migration closes, and stops
    -- an owner from silently demoting themselves out of the org.
    IF p_user_id = v_caller THEN
        RAISE EXCEPTION 'you cannot change your own role'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT role INTO v_current_role
    FROM public.organization_memberships
    WHERE organization_id = p_organization_id AND user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'that user is not a member of this organization';
    END IF;

    -- Never strand the org without an owner.
    IF v_current_role = 'owner' AND p_role <> 'owner'
       AND app.active_owner_count(p_organization_id) <= 1 THEN
        RAISE EXCEPTION 'cannot demote the last owner of an organization';
    END IF;

    UPDATE public.organization_memberships
    SET role = p_role
    WHERE organization_id = p_organization_id AND user_id = p_user_id;
END;
$$;

COMMENT ON PROCEDURE app.set_member_role(uuid, uuid, text) IS
    'Owner-only. Cannot change your own role, and cannot demote the last owner.';

-- ----------------------------------------------------------------------------
-- 7. set_member_active — deactivate/reactivate (memberships are never deleted;
--    every RLS predicate already keys off is_active).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.set_member_active(
    p_organization_id uuid,
    p_user_id         uuid,
    p_is_active       boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller       uuid := app.current_user_id();
    v_current_role text;
BEGIN
    IF NOT app.caller_may_manage_members(p_organization_id) THEN
        RAISE EXCEPTION 'only an owner may deactivate members'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_user_id = v_caller THEN
        RAISE EXCEPTION 'you cannot deactivate yourself'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT role INTO v_current_role
    FROM public.organization_memberships
    WHERE organization_id = p_organization_id AND user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'that user is not a member of this organization';
    END IF;

    IF v_current_role = 'owner' AND NOT p_is_active
       AND app.active_owner_count(p_organization_id) <= 1 THEN
        RAISE EXCEPTION 'cannot deactivate the last owner of an organization';
    END IF;

    UPDATE public.organization_memberships
    SET is_active = p_is_active
    WHERE organization_id = p_organization_id AND user_id = p_user_id;
END;
$$;

COMMENT ON PROCEDURE app.set_member_active(uuid, uuid, boolean) IS
    'Owner-only. Cannot deactivate yourself or the last owner.';

-- ----------------------------------------------------------------------------
-- 8. Grants. The procedures cross the RLS boundary, so PUBLIC must not hold
--    EXECUTE (the 0003–0007 convention).
-- ----------------------------------------------------------------------------
REVOKE ALL ON PROCEDURE app.invite_org_member(uuid, text, text)      FROM PUBLIC;
REVOKE ALL ON PROCEDURE app.set_member_role(uuid, uuid, text)        FROM PUBLIC;
REVOKE ALL ON PROCEDURE app.set_member_active(uuid, uuid, boolean)   FROM PUBLIC;
REVOKE ALL ON FUNCTION  app.accept_invitation(uuid, text)            FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT ON public.organization_invitations TO mosaiz_app_user;
        GRANT EXECUTE ON PROCEDURE app.invite_org_member(uuid, text, text)    TO mosaiz_app_user;
        GRANT EXECUTE ON PROCEDURE app.set_member_role(uuid, uuid, text)      TO mosaiz_app_user;
        GRANT EXECUTE ON PROCEDURE app.set_member_active(uuid, uuid, boolean) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION  app.accept_invitation(uuid, text)          TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION  app.caller_may_manage_members(uuid)        TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION  app.active_owner_count(uuid)               TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION  app.shares_org_with_caller(uuid)           TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
