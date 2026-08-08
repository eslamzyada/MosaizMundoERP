-- ============================================================================
-- 0048_organization_settings.sql — who may change what the restaurant IS
--
-- `organizations` has carried one PERMISSIVE policy since 0001:
--
--     user_belongs_to_org  FOR ALL  USING (app.user_belongs_to_org(id))
--
-- FOR ALL means SELECT, INSERT, UPDATE and DELETE, and the app role holds
-- every one of those privileges. So any member of a restaurant — a waiter, a
-- kitchen user, anybody with a login — could rename it, change its slug,
-- deactivate it, or DELETE the row outright. Deleting it cascades: every
-- order, every payment, every stocktake, every shift, gone.
--
-- Nothing in the application has ever done any of that. It was reachable, not
-- used, which is the most dangerous shape a permission can have — it survives
-- review because no screen exercises it, and it is still one crafted request
-- away.
--
-- ----------------------------------------------------------------------------
-- PER COMMAND, NOT `FOR ALL`.
--
-- The correction is the shape 0010 and 0037 already use, and the reason is
-- specific: SELECT must stay open to every member. A waiter's app reads the
-- restaurant's name to put at the top of a screen, and the floor and the till
-- resolve the organization on nearly every request. One `FOR ALL` policy
-- gated on being an owner would close reading too, and the entire product
-- would go dark for everybody below an owner.
--
-- ----------------------------------------------------------------------------
-- AND NOBODY DELETES A RESTAURANT THROUGH THE API.
--
-- There is no policy for it and the privilege is revoked. Closing a business
-- is `is_active = false`, which keeps every record that anybody may later be
-- asked to produce — a tax authority, a supplier dispute, an employment
-- claim. An organization is removed by an operator who has thought about it,
-- with a backup, and not by a request that arrives at three in the morning.
-- ============================================================================

BEGIN;

-- The old blanket rule. Dropped rather than narrowed, because a PERMISSIVE
-- policy left in place would keep granting what the new ones withhold —
-- permissive policies OR together.
DROP POLICY user_belongs_to_org ON public.organizations;

-- ----------------------------------------------------------------------------
-- Reading: every member, exactly as before. This is the half that must not
-- change, and it is stated first so the diff reads that way.
-- ----------------------------------------------------------------------------
CREATE POLICY readable_by_members ON public.organizations
    FOR SELECT USING (app.user_belongs_to_org(id));

-- ----------------------------------------------------------------------------
-- Writing: the owner, and only the owner.
--
-- NOT owner-or-regional-manager, which is the gate app.set_module uses. That
-- one is about what the restaurant PAYS FOR, and a regional manager runs the
-- operation. This is about what the restaurant IS — its name, its slug, and
-- whether it is trading at all. A regional manager can be given that by
-- widening the array below; it is deliberately not the default.
--
-- USING and WITH CHECK are both present and both required. USING decides which
-- rows may be touched; WITH CHECK decides what they may be turned into.
-- Without WITH CHECK an owner could set organization_id... there is no such
-- column here, but the same omission on any tenant-scoped table lets a row be
-- moved into another restaurant, and the habit is what keeps that from
-- happening the next time this pattern is copied.
-- ----------------------------------------------------------------------------
CREATE POLICY owner_may_edit ON public.organizations
    FOR UPDATE
    USING (app.user_has_org_role(id, ARRAY['owner']))
    WITH CHECK (app.user_has_org_role(id, ARRAY['owner']));

-- No INSERT policy: creating a tenant still goes through
-- app.provision_new_tenant, and negative_checks has asserted that barrier
-- since 0001.
--
-- No DELETE policy either — see the header. Belt and braces, because a policy
-- added later by somebody who did not read this would silently re-open it:
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        REVOKE DELETE ON public.organizations FROM mosaiz_app_user;
    END IF;
END;
$$;

COMMENT ON TABLE public.organizations IS
    'One restaurant. Readable by every member; editable only by an owner (0048); never deletable through the API — close a restaurant with is_active, which keeps the records somebody may later be asked to produce. plan_tier moves only through app.change_plan (0044).';

COMMIT;
