-- ============================================================================
-- Migration 0001: Multi-Tenancy Foundation
-- Mosaiz Mundo ERP
--
-- Creates:
--   * organizations              (tenant root, with plan_tier for tiered access)
--   * organization_memberships   (user <-> org mapping, multi-branch franchising)
--   * user_belongs_to_org        (base RLS policy, applied to both tables)
--
-- Architecture references:
--   * docs/rls_policies.md   — Golden Rule: every operational table carries
--     organization_id; isolation is enforced by RLS, never by app-side filters.
--   * docs/ai_system_prompt.md — all operational tables carry updated_at
--     maintained by database triggers (mobile delta-sync).
--
-- Session contract:
--   The backend sets the authenticated user for each pooled connection with
--     SET LOCAL app.current_user_id = '<uuid>';
--   inside the transaction. RLS derives everything else from that. The
--   application must connect as a role WITHOUT superuser/BYPASSRLS, or RLS
--   is silently skipped.
-- ============================================================================

BEGIN;

-- Internal helper functions live in "app"; operational tables stay in "public".
CREATE SCHEMA IF NOT EXISTS app;

-- ----------------------------------------------------------------------------
-- updated_at trigger (mandated for every operational table)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.set_updated_at() IS
    'BEFORE UPDATE trigger: stamps updated_at so mobile clients can delta-sync.';

-- ----------------------------------------------------------------------------
-- organizations — the tenant root
-- ----------------------------------------------------------------------------
CREATE TABLE public.organizations (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL CHECK (length(trim(name)) > 0),
    slug        text        NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    -- Tiered feature access (docs/rls_policies.md §3). Premium modules check
    -- this before executing. CHECK constraint (not enum) so tiers can be
    -- renamed/retired in a plain migration.
    plan_tier   text        NOT NULL DEFAULT 'basic'
                            CHECK (plan_tier IN ('basic', 'standard', 'premium', 'enterprise')),
    is_active   boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organizations_slug_key ON public.organizations (slug);

COMMENT ON TABLE public.organizations IS
    'Tenant root. Every operational table references organizations.id and is isolated by RLS.';
COMMENT ON COLUMN public.organizations.plan_tier IS
    'Subscription tier gating premium modules (BI dashboards, advanced API syncs).';

CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- organization_memberships — user <-> org mapping
-- A single user may hold multiple memberships (multi-branch franchising);
-- regional managers switch branches without logging out.
-- ----------------------------------------------------------------------------
CREATE TABLE public.organization_memberships (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid        NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    -- No FK yet: the identity provider (auth.users / app users table) lands in
    -- a later migration. RLS only needs the uuid to match the session user.
    user_id         uuid        NOT NULL,
    -- RBAC maps permissions to human job titles (docs/rls_policies.md §4).
    -- Fine-grained permission mapping arrives with the RBAC migration; this
    -- column is the anchor it will join against.
    role            text        NOT NULL DEFAULT 'staff'
                                CHECK (role IN ('owner', 'regional_manager', 'branch_manager',
                                                'accountant', 'cashier', 'staff')),
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, user_id)
);

-- "Which branches can this user see?" — org-switcher and RLS both hit this.
CREATE INDEX organization_memberships_user_id_idx
    ON public.organization_memberships (user_id)
    WHERE is_active;

COMMENT ON TABLE public.organization_memberships IS
    'Grants a user access to one organization. Multiple rows per user = multi-branch access.';

CREATE TRIGGER trg_organization_memberships_updated_at
    BEFORE UPDATE ON public.organization_memberships
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- Session identity + membership check helpers
-- ----------------------------------------------------------------------------

-- Reads the user id the backend bound to this transaction. Returns NULL (never
-- errors) when unset, so unauthenticated sessions simply see zero rows.
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app.current_user_id() IS
    'Authenticated user for this transaction; set via SET LOCAL app.current_user_id.';

-- STABLE SECURITY DEFINER per docs/rls_policies.md §4: the planner caches the
-- result within a statement, and SECURITY DEFINER lets the check read
-- organization_memberships without recursing into the RLS policy on that same table.
CREATE OR REPLACE FUNCTION app.user_belongs_to_org(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.organization_memberships m
        WHERE m.organization_id = target_organization_id
          AND m.user_id = app.current_user_id()
          AND m.is_active
    );
$$;

COMMENT ON FUNCTION app.user_belongs_to_org(uuid) IS
    'True when the session user holds an active membership in the given organization.';

-- ----------------------------------------------------------------------------
-- Row Level Security — policy: user_belongs_to_org
--
-- ENABLE, deliberately not FORCE: the table owner (the migration role) stays
-- exempt, which is what lets the SECURITY DEFINER membership check above read
-- organization_memberships without recursing into this very policy. Isolation
-- therefore depends on the application connecting as a NON-OWNER role with no
-- BYPASSRLS — enforce that in the connection setup.
-- ----------------------------------------------------------------------------
ALTER TABLE public.organizations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships  ENABLE ROW LEVEL SECURITY;

-- An organization row is visible/mutable only to its own members.
CREATE POLICY user_belongs_to_org ON public.organizations
    FOR ALL
    USING      (app.user_belongs_to_org(id))
    WITH CHECK (app.user_belongs_to_org(id));

-- Membership rows are visible/mutable only to members of that organization.
CREATE POLICY user_belongs_to_org ON public.organization_memberships
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- NOTE (tenant bootstrap): WITH CHECK intentionally blocks ordinary sessions
-- from INSERTing a brand-new organization — nobody is a member of an org that
-- does not exist yet. Tenant provisioning (create org + first owner
-- membership, atomically) will ship as a SECURITY DEFINER stored procedure in
-- a follow-up migration, in line with the "unified stored procedures" mandate
-- in docs/ai_system_prompt.md. Do not weaken this policy to work around it.

-- ----------------------------------------------------------------------------
-- Grants for the application role
--
-- Migrations run as the database owner; the application connects as
-- mosaiz_app_user (non-owner, no BYPASSRLS), so every privilege it holds is
-- explicit. USAGE on schema "app" is required because the RLS policies above
-- call app.user_belongs_to_org() with the privileges of the querying role.
-- Guarded so the migration still applies in environments without the role.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT USAGE ON SCHEMA app TO mosaiz_app_user;
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON public.organizations, public.organization_memberships
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
