-- ============================================================================
-- Migration 0003: Tenant Provisioning Pipeline
-- Mosaiz Mundo ERP
--
-- Resolves the bootstrap restriction from 0001: the user_belongs_to_org
-- WITH CHECK policy blocks ordinary sessions from creating a brand-new
-- organization (nobody is a member of an org that does not exist yet).
-- Provisioning therefore runs through this SECURITY DEFINER procedure —
-- the single sanctioned path that crosses the RLS boundary, in line with the
-- "unified stored procedures" mandate in docs/ai_system_prompt.md.
--
-- Creates:
--   * app.provision_new_tenant(new_user_id, user_email, org_name, org_slug,
--                              plan_tier)
--
-- Depends on: 0001 (organizations, organization_memberships), 0002 (users)
-- ============================================================================

BEGIN;

CREATE OR REPLACE PROCEDURE app.provision_new_tenant(
    new_user_id uuid,
    user_email  text,
    org_name    text,
    org_slug    text,
    plan_tier   text
)
LANGUAGE plpgsql
SECURITY DEFINER            -- runs as the migration role (table owner): the
                            -- only way an app session may cross the RLS
                            -- boundary for tenant bootstrap
SET search_path = ''        -- SECURITY DEFINER hygiene: no search_path
                            -- hijacking; every object fully qualified
AS $$
DECLARE
    new_org_id uuid;
BEGIN
    -- 1. Identity anchor. ON CONFLICT (id) DO NOTHING: an existing identity
    --    provisioning an additional organization is the multi-branch
    --    franchising case (docs/rls_policies.md §2), not an error. A same-id
    --    row already present is left untouched; a *different* id reusing an
    --    existing email still fails on the users.email UNIQUE constraint.
    INSERT INTO public.users (id, email)
    VALUES (new_user_id, user_email)
    ON CONFLICT (id) DO NOTHING;

    -- 2. Organization. Validity of org_name / org_slug / plan_tier is
    --    enforced by the CHECK constraints on public.organizations.
    INSERT INTO public.organizations (name, slug, plan_tier)
    VALUES (org_name, org_slug, plan_tier)
    RETURNING id INTO new_org_id;

    -- 3. First membership: the provisioning identity owns the new tenant.
    INSERT INTO public.organization_memberships (organization_id, user_id, role)
    VALUES (new_org_id, new_user_id, 'owner');
END;
$$;

COMMENT ON PROCEDURE app.provision_new_tenant(uuid, text, text, text, text) IS
    'Atomic tenant bootstrap: IdP identity -> organization -> owner membership. '
    'Sole sanctioned RLS-crossing path for creating a new organization.';

-- ----------------------------------------------------------------------------
-- Execution rights. Routines default to EXECUTE for PUBLIC — revoke that
-- first so only the application role may provision tenants.
-- ----------------------------------------------------------------------------
REVOKE ALL ON PROCEDURE app.provision_new_tenant(uuid, text, text, text, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE
            ON PROCEDURE app.provision_new_tenant(uuid, text, text, text, text)
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
