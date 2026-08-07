-- ============================================================================
-- 0044_plans.sql — what a tenant is ENTITLED to, as opposed to what it runs
--
-- 0037 made every capability switchable per restaurant. It deliberately shipped
-- without touching `organizations.plan_tier`, so that entitlement worked before
-- pricing was involved. This is the pricing half, and it is one idea:
--
--     THE PLAN IS A CEILING, NOT AN ASSIGNMENT.
--
-- A tenant may switch anything OFF at any tier — somebody who does not want
-- الجرد should not be made to look at it — but may only switch something ON if
-- the plan reaches it. Which is why this changes exactly one code path
-- (`app.set_module`'s enable branch) and no read path at all. Nothing that
-- already works stops working because a price list now exists.
--
-- ----------------------------------------------------------------------------
-- THE THREE GATES, in the order they run. They get confused; they must not be.
--
--   1. ENTITLEMENT  the tenant bought this      → min_plan, this migration
--   2. MODULE       the tenant switched it on   → app.org_has_module (0037)
--   3. PERMISSION   this user may do it         → 0010's role policies
--
-- Each answers a different question and each gets its own SQLSTATE, because an
-- API that cannot tell them apart gives the wrong instruction: "upgrade your
-- plan" when the fix is a switch, or "ask your owner" when the fix is money.
-- 0A000 already means "that module is off" (0038, 0043). Entitlement therefore
-- gets its own code, MZ402 — a deliberate echo of HTTP 402.
--
-- ----------------------------------------------------------------------------
-- GRANDFATHERING, and why it is not optional here.
--
-- Every organization in this database is on `basic`, because nothing has ever
-- read the column. Applying the matrix literally would switch off insights,
-- exports, recipes, purchasing, stocktake, waste and performance for every
-- existing tenant the moment this migration lands — a migration that silently
-- removes a working feature breaks somebody's Tuesday.
--
-- So the backfill marks what is already on and above its plan as
-- `grandfathered`, and grandfathered means the enable path lets it through.
-- It is a record of a promise, not a hole in the gate: it is only ever set by
-- this migration, it can only be cleared, and an explicit plan change clears
-- it — at which point the tenant has made a commercial decision of its own.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. What each capability costs, as DATA. Not a CASE expression in a function
--    somewhere, so that repricing is an UPDATE and not a deployment.
-- ----------------------------------------------------------------------------

ALTER TABLE public.modules
    ADD COLUMN min_plan text NOT NULL DEFAULT 'basic';

ALTER TABLE public.modules
    ADD CONSTRAINT modules_min_plan_check
    CHECK (min_plan IN ('basic', 'standard', 'premium', 'enterprise'));

COMMENT ON COLUMN public.modules.min_plan IS
    'The cheapest plan that may switch this module ON (0044). A ceiling, not an assignment: any tier may switch it off.';

-- The matrix. Good / Better / Best, which is about BUNDLING — the value metric
-- is the branch, and branch count is what should drive the bill.
UPDATE public.modules SET min_plan = 'basic' WHERE key IN (
    -- A restaurant that cannot count its stock or drive its printers does not
    -- have a working till, and a paywall in front of the core is not packaging.
    'inventory', 'printers'
);

UPDATE public.modules SET min_plan = 'standard' WHERE key IN (
    'recipes', 'purchasing', 'stocktake', 'waste',
    -- Rotas, the time clock and table bookings are what a restaurant with
    -- staff and a phone needs. A one-person café needs none of them.
    'labour', 'reservations'
);

UPDATE public.modules SET min_plan = 'premium' WHERE key IN (
    'insights', 'exports', 'performance',
    -- A customer-facing sales channel earns its own money. It belongs with the
    -- reporting that tells you whether it is working.
    'public_ordering'
);

UPDATE public.modules SET min_plan = 'enterprise' WHERE key IN (
    -- The two-person rule is multi-branch governance. A single-owner café
    -- neither needs it nor should pay for it — and note its "off" state is not
    -- absence but SELF-APPROVAL, so gating it removes a brake, never a feature.
    'menu_approval'
);

-- ----------------------------------------------------------------------------
-- 2. Plan ordering, and the entitlement question itself.
-- ----------------------------------------------------------------------------

CREATE FUNCTION app.plan_rank(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE p_plan
               WHEN 'basic'      THEN 1
               WHEN 'standard'   THEN 2
               WHEN 'premium'    THEN 3
               WHEN 'enterprise' THEN 4
               -- Fail closed. An unknown or missing plan is worth the floor,
               -- never the benefit of the doubt: this gate carries revenue, and
               -- "allow on error" on a revenue gate gives the product away to
               -- whoever can produce a malformed row.
               ELSE 1
           END;
$$;

COMMENT ON FUNCTION app.plan_rank(text) IS
    'Plans as a total order (0044). Anything unrecognised ranks as basic — fail closed, never open, on a gate that carries revenue.';

CREATE FUNCTION app.plan_includes(p_organization_id uuid, p_module text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE(
        (SELECT app.plan_rank(o.plan_tier) >= app.plan_rank(m.min_plan)
           FROM public.organizations o, public.modules m
          WHERE o.id = p_organization_id
            AND m.key = p_module),
        false);  -- No such org, or no such module: entitled to nothing.
$$;

COMMENT ON FUNCTION app.plan_includes(uuid, text) IS
    'Whether a tenant''s PLAN reaches a capability (0044) — separate from whether it has switched it on, which is app.org_has_module. SECURITY DEFINER so the answer does not depend on the caller being able to read the plan.';

-- ----------------------------------------------------------------------------
-- 3. Grandfathering: the promise this migration must keep.
-- ----------------------------------------------------------------------------

ALTER TABLE public.organization_modules
    ADD COLUMN grandfathered boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organization_modules.grandfathered IS
    'This tenant had the capability on before plans existed (0044), so the plan gate lets it through. Only ever set by 0044''s backfill; cleared for good by any explicit plan change.';

UPDATE public.organization_modules om
   SET grandfathered = true
 WHERE om.enabled
   AND NOT app.plan_includes(om.organization_id, om.module_key);

-- Tenants who never wrote a row are on the module's default, which for
-- everything above basic is also "on". Those need the same promise, so write
-- the row that records it rather than leaving it to be inferred.
INSERT INTO public.organization_modules
    (organization_id, module_key, enabled, grandfathered, decided_at)
SELECT o.id, m.key, true, true, now()
  FROM public.organizations o
 CROSS JOIN public.modules m
 WHERE m.default_enabled
   AND NOT app.plan_includes(o.id, m.key)
   AND NOT EXISTS (
       SELECT FROM public.organization_modules om
        WHERE om.organization_id = o.id AND om.module_key = m.key)
ON CONFLICT (organization_id, module_key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3b. The default has to respect the ceiling too.
--
-- 0037 made "no row" mean the catalogue default, so that a module added in a
-- later migration would not switch itself off for every existing restaurant.
-- That fallback is now a hole: an organization created TOMORROW on `basic`
-- has no rows, so it would run insights, exports and menu_approval — the whole
-- premium and enterprise shelf — for nothing, and the gate above would never
-- be asked because nobody would need to switch anything on.
--
-- So the default becomes the INTERSECTION. An explicit row still wins outright
-- — that is where a tenant's own choice lives, and where the backfill above
-- just wrote every grandfathered promise — but an ABSENT row cannot grant more
-- than the plan reaches.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.org_has_module(p_organization_id uuid, p_module text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE(
        (SELECT om.enabled
           FROM public.organization_modules om
          WHERE om.organization_id = p_organization_id
            AND om.module_key = p_module),
        (SELECT m.default_enabled AND app.plan_includes(p_organization_id, p_module)
           FROM public.modules m WHERE m.key = p_module),
        false);
$$;

COMMENT ON FUNCTION app.org_has_module(uuid, text) IS
    'Whether a tenant runs a capability (0037), capped by what its plan reaches when it has never chosen (0044). SECURITY DEFINER so a policy can ask it without the caller needing to read the table, and STABLE so it is asked once per statement rather than once per row.';

-- ----------------------------------------------------------------------------
-- 4. Why a plan moved. A downgrade takes capability away, so it is the kind of
--    thing somebody will later need to prove, or dispute.
-- ----------------------------------------------------------------------------

CREATE TABLE public.plan_changes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    from_plan         text NOT NULL,
    to_plan           text NOT NULL,
    reason            text,
    -- NULL means an operator moved it outside any session — billing runs as
    -- postgres, and pretending otherwise would put a fictional user on a
    -- commercial record.
    changed_by        uuid REFERENCES public.users (id) ON DELETE SET NULL,
    modules_disabled  text[] NOT NULL DEFAULT '{}',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plan_changes_reason_check
        CHECK (reason IS NULL OR (btrim(reason) <> '' AND char_length(reason) <= 500))
);

CREATE INDEX plan_changes_org_idx ON public.plan_changes (organization_id, created_at DESC);

COMMENT ON TABLE public.plan_changes IS
    'Every move of organizations.plan_tier (0044), with what it switched off. Deny-by-default: written only by app.change_plan, never by the application role.';

ALTER TABLE public.plan_changes ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_plan_changes_updated_at
    BEFORE UPDATE ON public.plan_changes
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Readable by the restaurant it happened to. No INSERT, UPDATE or DELETE
-- policy exists, so those are refused for everyone regardless of role — the
-- deny-by-default shape the identity-adjacent tables use.
CREATE POLICY user_belongs_to_org ON public.plan_changes
    FOR SELECT USING (app.user_belongs_to_org(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT ON public.plan_changes TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. The gate itself: one new branch in the one function that turns things on.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.set_module(
    p_organization_id uuid,
    p_module          text,
    p_enabled         boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor   uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_missing text;
    v_blocker text;
    v_grand   boolean;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'no identity bound' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- What the restaurant is paying for is the owner's decision, not the
    -- branch manager's and certainly not the kitchen's.
    IF NOT app.user_has_org_role(p_organization_id, ARRAY['owner', 'regional_manager']) THEN
        RAISE EXCEPTION 'only an owner or a regional manager may change which modules run'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT EXISTS (SELECT FROM public.modules WHERE key = p_module) THEN
        RAISE EXCEPTION 'no such module: %', p_module USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_enabled THEN
        -- 0044. Asked FIRST, because "your plan does not include this" is the
        -- more useful answer than "turn on its dependency" when both are true —
        -- fixing the dependency would not get the tenant any closer.
        SELECT om.grandfathered INTO v_grand
          FROM public.organization_modules om
         WHERE om.organization_id = p_organization_id
           AND om.module_key = p_module;

        IF NOT app.plan_includes(p_organization_id, p_module)
           AND NOT COALESCE(v_grand, false) THEN
            RAISE EXCEPTION 'module % needs the % plan', p_module,
                (SELECT m.min_plan FROM public.modules m WHERE m.key = p_module)
                USING ERRCODE = 'MZ402';
        END IF;

        SELECT d INTO v_missing
          FROM public.modules m, unnest(m.depends_on) AS d
         WHERE m.key = p_module
           AND NOT app.org_has_module(p_organization_id, d)
         LIMIT 1;

        IF v_missing IS NOT NULL THEN
            RAISE EXCEPTION 'module % needs % turned on first', p_module, v_missing
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    ELSE
        SELECT m.key INTO v_blocker
          FROM public.modules m
         WHERE p_module = ANY (m.depends_on)
           AND app.org_has_module(p_organization_id, m.key)
         LIMIT 1;

        IF v_blocker IS NOT NULL THEN
            RAISE EXCEPTION 'module % is still on and depends on %', v_blocker, p_module
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;

    INSERT INTO public.organization_modules
        (organization_id, module_key, enabled, decided_by, decided_at)
    VALUES (p_organization_id, p_module, p_enabled, v_actor, now())
    ON CONFLICT (organization_id, module_key) DO UPDATE
        SET enabled    = EXCLUDED.enabled,
            decided_by = EXCLUDED.decided_by,
            decided_at = EXCLUDED.decided_at;

    RETURN p_enabled;
END;
$$;

COMMENT ON FUNCTION app.set_module(uuid, text, boolean) IS
    'Turn a capability on or off (0037), within what the plan reaches (0044). The plan is asked only on the ENABLE path: a tenant may always switch something off.';

-- ----------------------------------------------------------------------------
-- 6. Moving a plan. The ONLY way plan_tier changes, enforced by a trigger
--    rather than by convention — a stray UPDATE would otherwise leave modules
--    switched on above the plan that is being billed.
-- ----------------------------------------------------------------------------

CREATE FUNCTION app.reject_direct_plan_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.plan_tier IS DISTINCT FROM OLD.plan_tier
       AND COALESCE(current_setting('app.plan_change', true), '') <> '1' THEN
        RAISE EXCEPTION 'plan_tier moves only through app.change_plan'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_organizations_plan_tier_guard
    BEFORE UPDATE OF plan_tier ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION app.reject_direct_plan_change();

CREATE FUNCTION app.change_plan(
    p_organization_id uuid,
    p_plan            text,
    p_reason          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor    uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_from     text;
    v_disabled text[] := '{}';
    v_id       uuid;
BEGIN
    IF p_plan NOT IN ('basic', 'standard', 'premium', 'enterprise') THEN
        RAISE EXCEPTION 'no such plan: %', p_plan USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT o.plan_tier INTO v_from
      FROM public.organizations o
     WHERE o.id = p_organization_id
       FOR UPDATE;

    IF v_from IS NULL THEN
        RAISE EXCEPTION 'no such organization' USING ERRCODE = 'no_data_found';
    END IF;

    IF v_from = p_plan THEN
        RAISE EXCEPTION 'already on the % plan', p_plan
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    PERFORM set_config('app.plan_change', '1', true);
    UPDATE public.organizations SET plan_tier = p_plan WHERE id = p_organization_id;
    PERFORM set_config('app.plan_change', '', true);

    -- An explicit plan change ends grandfathering. The promise was to protect
    -- tenants from THIS MIGRATION, not to hand out a permanent entitlement
    -- that survives a commercial decision made afterwards.
    UPDATE public.organization_modules
       SET grandfathered = false
     WHERE organization_id = p_organization_id
       AND grandfathered;

    -- A downgrade removes the ability to WRITE, never the record of what was
    -- written. Rows stay; reports about the past do not move.
    WITH turned_off AS (
        UPDATE public.organization_modules om
           SET enabled = false, decided_by = v_actor, decided_at = now()
         WHERE om.organization_id = p_organization_id
           AND om.enabled
           AND NOT app.plan_includes(om.organization_id, om.module_key)
        RETURNING om.module_key
    )
    SELECT COALESCE(array_agg(module_key ORDER BY module_key), '{}')
      INTO v_disabled FROM turned_off;

    -- A module with no row of its own needs nothing written: since 3b the
    -- default is already the intersection with the plan, so it follows the
    -- downgrade by itself. Writing an explicit `false` here would be worse
    -- than redundant — it would make a later UPGRADE leave that module off
    -- while an identical tenant who never had a row got it back.

    INSERT INTO public.plan_changes
        (organization_id, from_plan, to_plan, reason, changed_by, modules_disabled)
    VALUES (p_organization_id, v_from, p_plan, NULLIF(btrim(p_reason), ''), v_actor, v_disabled)
    RETURNING id INTO v_id;

    -- Somebody has to be told, and the owner is the one who will be asked why
    -- a screen vanished. 0036 already does delivery.
    PERFORM app.notify_roles(
        p_organization_id,
        ARRAY['owner', 'regional_manager'],
        'plan_changed',
        'تغيّرت خطة الاشتراك: ' || v_from || ' ← ' || p_plan,
        CASE WHEN cardinality(v_disabled) > 0
             THEN 'تم إيقاف: ' || array_to_string(v_disabled, '، ')
             ELSE NULL END,
        '/modules',
        v_actor);

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION app.change_plan(uuid, text, text) IS
    'The only way organizations.plan_tier moves (0044). Disables what the new plan does not reach, ends grandfathering, writes plan_changes and notifies the owner. NOT granted to the application role: there is no self-service upgrade without a payment flow, and a tenant that could call this could promote itself for free.';

-- Deliberately NOT granted to mosaiz_app_user. Billing is an operator action
-- until there is a payment flow to authorise it.
REVOKE EXECUTE ON FUNCTION app.change_plan(uuid, text, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.plan_rank(text) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.plan_includes(uuid, text) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
