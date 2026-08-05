-- ============================================================================
-- Migration 0037: A tenant only runs the parts of the system it needs
-- Mosaiz Mundo ERP
--
-- `organizations.plan_tier` has existed since 0001 with four values, and in
-- thirty-six migrations NOTHING has ever read it. Tiering has been a column,
-- not a system. This makes it one — and, more importantly, lets a restaurant
-- switch off the parts of the ERP it does not run. A café with no stockroom
-- should not meet أوامر الشراء in its sidebar, and a single-branch owner
-- should not need a second person to approve a price change.
--
-- ----------------------------------------------------------------------------
-- AN ENTITLEMENT IS NOT A FEATURE FLAG.
--
-- A feature flag answers "is this code ready" and is meant to be deleted. An
-- entitlement answers "is this tenant allowed" and is permanent. Encoding the
-- second as the first is the standard way this rots: a pile of permanent
-- booleans that nobody dares remove. So this is a table with a catalogue, a
-- decision procedure and an audit trail — not a JSON blob of flags.
--
-- ----------------------------------------------------------------------------
-- WHERE THE GATE LIVES, AND WHY IT IS PER COMMAND.
--
-- Every other rule in this system is enforced in the database. A module that
-- were only hidden in the sidebar would be the first rule here a client could
-- bypass with curl. So a module-owned table gets a RESTRICTIVE policy, exactly
-- like 0010's role gates.
--
-- But FOR INSERT / UPDATE / DELETE only, NEVER FOR ALL. Turning a module off
-- stops new work; it must not make last month's figures change. A FOR ALL
-- policy covers SELECT, and the purchase orders behind a delivered stock batch
-- would vanish from the reports that explain that batch's cost — the books
-- would silently rewrite themselves. History stays readable. That is the
-- single most important line in this file.
--
-- Two modules are marked as enforced in the application instead, honestly:
-- reporting and exports have no writes to gate, and the only thing a bypass
-- would expose is the tenant's own data, which RLS already scopes to them.
-- Where there is no write, there is no database gate to be had; pretending
-- otherwise would be theatre.
--
-- Depends on: 0001 (organizations), 0010 (RBAC), 0021 (POs), 0033 (criteria),
--             0035 (menu cycle)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- The catalogue. Global reference data, identical for every tenant, so it is
-- the one table here with no organization_id — and it says, per row, where its
-- own gate is enforced.
-- ----------------------------------------------------------------------------
CREATE TABLE public.modules (
    key             text PRIMARY KEY
                    CHECK (key ~ '^[a-z][a-z_]{2,30}$'),
    name_ar         text NOT NULL,
    description_ar  text NOT NULL,

    -- What must be on for this to mean anything. Purchasing without an
    -- inventory to purchase INTO is a form to nowhere.
    depends_on      text[] NOT NULL DEFAULT '{}',

    -- 'database' — a RESTRICTIVE policy refuses the write.
    -- 'application' — read-only capability; the router refuses it. Named so
    -- that nobody later assumes a policy exists where none can.
    enforced_in     text NOT NULL DEFAULT 'database'
                    CHECK (enforced_in IN ('database', 'application')),

    -- Off until somebody turns it on, or on until somebody turns it off. The
    -- default for a NEW tenant; existing tenants are backfilled below with
    -- everything on, because taking a working feature away in a migration is
    -- not a decision this file gets to make.
    default_enabled boolean NOT NULL DEFAULT true,

    sort_order      integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.modules IS
    'The catalogue of switchable capabilities (0037). Global reference data — no organization_id — and each row records where its gate is enforced, because two of them cannot have a database gate at all.';

ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;

-- Readable by everyone: it is a price list, not somebody's data. No write
-- policy and no write grant — the catalogue changes in a migration.
CREATE POLICY readable_by_all ON public.modules
    FOR SELECT USING (true);

INSERT INTO public.modules (key, name_ar, description_ar, depends_on, enforced_in, sort_order) VALUES
    ('inventory',    'المخزون',            'المكوّنات الخام، الدفعات، والتكلفة',                    '{}',            'database',    10),
    ('recipes',      'الوصفات',            'مكوّنات كل صنف، وحساب تكلفته',                          '{inventory}',   'database',    20),
    ('purchasing',   'المشتريات',          'المورّدون وأوامر الشراء',                                '{inventory}',   'database',    30),
    ('stocktake',    'الجرد',              'العدّ الدوري وتسوية الفروقات',                           '{inventory}',   'database',    40),
    ('waste',        'الهدر',              'تسجيل التالف ووجبات الموظفين',                          '{inventory}',   'database',    50),
    ('performance',  'تقييم الموظفين',     'المعايير والتقييمات الشهرية',                            '{}',            'database',    60),
    ('printers',     'الطابعات',           'وجهات الطباعة في الفروع',                                '{}',            'database',    70),
    ('menu_approval','دورة اعتماد القائمة','تغيير القائمة يحتاج موافقة شخص ثانٍ',                    '{}',            'database',    80),
    ('insights',     'المؤشرات',           'الرسوم البيانية والاتجاهات',                             '{}',            'application', 90),
    ('exports',      'التصدير',            'تنزيل التقارير كملفات PDF و Excel',                      '{}',            'application', 100);

-- ----------------------------------------------------------------------------
-- What each tenant has turned on.
-- ----------------------------------------------------------------------------
CREATE TABLE public.organization_modules (
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    module_key      text NOT NULL REFERENCES public.modules (key),

    enabled         boolean NOT NULL,
    -- Who decided, and when. An entitlement without an audit trail is a
    -- support conversation nobody can settle.
    decided_by      uuid REFERENCES public.users (id) ON DELETE SET NULL,
    decided_at      timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (organization_id, module_key)
);

COMMENT ON TABLE public.organization_modules IS
    'Which capabilities a tenant runs (0037). Written only through app.set_module — the application role has no INSERT, UPDATE or DELETE, because "which features am I paying for" is not a thing a client gets to answer about itself.';

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.organization_modules
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.organization_modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.organization_modules
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT ON public.modules TO mosaiz_app_user;
        -- SELECT only. Everyone may see what their restaurant runs; nobody may
        -- write it except through the procedure below.
        GRANT SELECT ON public.organization_modules TO mosaiz_app_user;
    END IF;
END;
$$;

-- Every existing tenant keeps everything it already has. A migration that
-- quietly removed a working feature would be a migration that broke somebody's
-- Tuesday.
INSERT INTO public.organization_modules (organization_id, module_key, enabled)
SELECT o.id, m.key, true
  FROM public.organizations o
 CROSS JOIN public.modules m;

-- ----------------------------------------------------------------------------
-- The question every policy below asks.
-- ----------------------------------------------------------------------------

/**
 * True when [p_organization_id] runs [p_module].
 *
 * A missing row means the tenant predates the module, so it falls back to the
 * catalogue default rather than to false — a new module must never silently
 * switch itself off for every existing restaurant on the day it ships.
 */
CREATE FUNCTION app.org_has_module(p_organization_id uuid, p_module text)
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
        (SELECT m.default_enabled FROM public.modules m WHERE m.key = p_module),
        false);
$$;

COMMENT ON FUNCTION app.org_has_module(uuid, text) IS
    'Whether a tenant runs a capability (0037). SECURITY DEFINER so a policy can ask it without the caller needing to read the table, and STABLE so it is asked once per statement rather than once per row.';

-- Readable by the policies, which run as the calling role.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.org_has_module(uuid, text) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Turning one on or off.
--
-- SECURITY DEFINER, owner-only, and it refuses to leave the tenant in a shape
-- that cannot work: no enabling a module whose dependency is off, no disabling
-- one that something still enabled depends on.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.set_module(
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

REVOKE EXECUTE ON FUNCTION app.set_module(uuid, text, boolean) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.set_module(uuid, text, boolean) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The gates.
--
-- FOR INSERT / UPDATE / DELETE, never FOR ALL. Read the header again if that
-- looks like an omission: SELECT is deliberately untouched on every one of
-- these, so that switching a module off stops new work without altering a
-- single number in a report about work already done.
--
-- DELETE is gated only where DELETE is actually granted — but it IS gated
-- there, because a FOR ALL permissive policy elsewhere would otherwise leave
-- deletion as the one write a disabled module still allows.
-- ----------------------------------------------------------------------------

-- inventory
CREATE POLICY require_module_insert ON public.raw_inventory_items
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'inventory'));
CREATE POLICY require_module_update ON public.raw_inventory_items
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'inventory'))
    WITH CHECK (app.org_has_module(organization_id, 'inventory'));
CREATE POLICY require_module_delete ON public.raw_inventory_items
    AS RESTRICTIVE FOR DELETE
    USING (app.org_has_module(organization_id, 'inventory'));

CREATE POLICY require_module_insert ON public.inventory_batches
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'inventory'));
CREATE POLICY require_module_update ON public.inventory_batches
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'inventory'))
    WITH CHECK (app.org_has_module(organization_id, 'inventory'));

-- recipes
CREATE POLICY require_module_insert ON public.bill_of_materials
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'recipes'));
CREATE POLICY require_module_update ON public.bill_of_materials
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'recipes'))
    WITH CHECK (app.org_has_module(organization_id, 'recipes'));
CREATE POLICY require_module_delete ON public.bill_of_materials
    AS RESTRICTIVE FOR DELETE
    USING (app.org_has_module(organization_id, 'recipes'));

-- purchasing
CREATE POLICY require_module_insert ON public.suppliers
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'purchasing'));
CREATE POLICY require_module_update ON public.suppliers
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'purchasing'))
    WITH CHECK (app.org_has_module(organization_id, 'purchasing'));

CREATE POLICY require_module_insert ON public.purchase_orders
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'purchasing'));
CREATE POLICY require_module_update ON public.purchase_orders
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'purchasing'))
    WITH CHECK (app.org_has_module(organization_id, 'purchasing'));

CREATE POLICY require_module_insert ON public.purchase_order_lines
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'purchasing'));
CREATE POLICY require_module_update ON public.purchase_order_lines
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'purchasing'))
    WITH CHECK (app.org_has_module(organization_id, 'purchasing'));
CREATE POLICY require_module_delete ON public.purchase_order_lines
    AS RESTRICTIVE FOR DELETE
    USING (app.org_has_module(organization_id, 'purchasing'));

-- stocktake
CREATE POLICY require_module_insert ON public.stocktakes
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'stocktake'));
CREATE POLICY require_module_update ON public.stocktakes
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'stocktake'))
    WITH CHECK (app.org_has_module(organization_id, 'stocktake'));

CREATE POLICY require_module_insert ON public.stocktake_items
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'stocktake'));
CREATE POLICY require_module_update ON public.stocktake_items
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'stocktake'))
    WITH CHECK (app.org_has_module(organization_id, 'stocktake'));

-- waste
CREATE POLICY require_module_insert ON public.stock_write_offs
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'waste'));
CREATE POLICY require_module_insert ON public.stock_write_off_lines
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'waste'));

-- performance
CREATE POLICY require_module_insert ON public.employee_ratings
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'performance'));
CREATE POLICY require_module_update ON public.employee_ratings
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'performance'))
    WITH CHECK (app.org_has_module(organization_id, 'performance'));

CREATE POLICY require_module_insert ON public.employee_criterion_scores
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'performance'));
CREATE POLICY require_module_update ON public.employee_criterion_scores
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'performance'))
    WITH CHECK (app.org_has_module(organization_id, 'performance'));

CREATE POLICY require_module_insert ON public.rating_criteria
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'performance'));
CREATE POLICY require_module_update ON public.rating_criteria
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'performance'))
    WITH CHECK (app.org_has_module(organization_id, 'performance'));
CREATE POLICY require_module_delete ON public.rating_criteria
    AS RESTRICTIVE FOR DELETE
    USING (app.org_has_module(organization_id, 'performance'));

-- printers
CREATE POLICY require_module_insert ON public.printers
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'printers'));
CREATE POLICY require_module_update ON public.printers
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'printers'))
    WITH CHECK (app.org_has_module(organization_id, 'printers'));
CREATE POLICY require_module_delete ON public.printers
    AS RESTRICTIVE FOR DELETE
    USING (app.org_has_module(organization_id, 'printers'));

-- ----------------------------------------------------------------------------
-- menu_approval is the odd one, and the most interesting.
--
-- It cannot simply be switched off. 0035 revoked INSERT and UPDATE on
-- sellable_items from the application role ENTIRELY — the only way the menu
-- changes is app.decide_menu_change. Turning "the approval cycle" off in the
-- naive sense would leave a restaurant unable to change its own menu at all.
--
-- So off does not mean "no cycle". It means SELF-APPROVAL: one person may
-- propose and immediately decide. The write still goes through the audited
-- path, the record of who changed what and why still exists, and what the
-- tenant actually gets rid of is the second person — which is the thing a
-- single-owner café was never going to have.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.decide_menu_change(
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

    -- The two-person rule, its original exception (a restaurant with a single
    -- approver would otherwise be locked out of its own menu), and since 0037
    -- a second one: a tenant that has switched the menu_approval module OFF has
    -- decided it does not want a second signature. The write still goes through
    -- this audited path either way — what a tenant may switch off is the second
    -- person, never the record of who changed what and why.
    IF v_request.requested_by = v_caller
       AND app.org_has_module(v_request.organization_id, 'menu_approval') THEN
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
COMMENT ON FUNCTION app.decide_menu_change(uuid, boolean, text) IS
    'The only path by which the menu changes (0035, amended 0037). The two-person rule is now conditional on the menu_approval module: off means one person may propose and decide, not that the audited path is bypassed.';

COMMIT;
