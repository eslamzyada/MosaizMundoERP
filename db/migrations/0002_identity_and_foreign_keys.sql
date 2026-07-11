-- ============================================================================
-- Migration 0002: Identity Anchor & Foreign Keys
-- Mosaiz Mundo ERP
--
-- Hybrid Identity Provider strategy: authentication lives in an external IdP
-- (Supabase Auth / Keycloak); this local users table mirrors the IdP-issued
-- UUID and acts as the relational anchor for every ERP foreign key.
--
-- Creates:
--   * users                                  (id = exact IdP-issued UUID)
--   * users_select_own / users_update_own    (RLS: a user sees only their row)
--   * organization_memberships.user_id  -> users.id  (ON DELETE CASCADE)
--
-- Depends on: 0001 (app.set_updated_at, app.current_user_id, RLS conventions)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- users — local mirror of the external IdP identity
-- ----------------------------------------------------------------------------
CREATE TABLE public.users (
    -- No DEFAULT: the id is always supplied by the external IdP, never minted
    -- locally. A locally-generated id would desynchronize the two systems.
    id          uuid        PRIMARY KEY,
    email       text        NOT NULL UNIQUE CHECK (length(trim(email)) > 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.users IS
    'Relational anchor for the external IdP. id is the IdP-issued UUID verbatim.';
COMMENT ON COLUMN public.users.id IS
    'Exact UUID issued by the external identity provider (Supabase Auth / Keycloak).';

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- Row Level Security — own-row visibility only
--
-- app.current_user_id() is the NULL-safe wrapper around
-- current_setting('app.current_user_id')::uuid from migration 0001.
--
-- Deliberately NO policy for INSERT or DELETE: with RLS enabled, a command
-- with no matching policy is denied, so identities can only be created or
-- removed through the provisioning pipeline (SECURITY DEFINER, migration
-- 0003) or by a privileged role — never directly by an app session.
-- ----------------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_own ON public.users
    FOR SELECT
    USING (id = app.current_user_id());

CREATE POLICY users_update_own ON public.users
    FOR UPDATE
    USING      (id = app.current_user_id())
    WITH CHECK (id = app.current_user_id());

-- ----------------------------------------------------------------------------
-- Foreign key: memberships now anchor to a real identity.
-- ON DELETE CASCADE — wiping a local identity scrubs its memberships.
-- ----------------------------------------------------------------------------
ALTER TABLE public.organization_memberships
    ADD CONSTRAINT organization_memberships_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- Grants for the application role (same convention as 0001: guarded so the
-- migration applies in environments without the role). INSERT/DELETE are
-- granted but remain unusable directly because no RLS policy allows them —
-- defense in depth, and they become usable only through SECURITY DEFINER
-- procedures owned by the migration role.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
