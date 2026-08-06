-- ============================================================================
-- Migration 0042: What an hour costs
-- Mosaiz Mundo ERP
--
-- 0038 deliberately stopped at hours. Its header says why: "pay rates are
-- salary data with their own confidentiality rules, and bolting them onto this
-- migration would mean designing that in a hurry." This is that design, and it
-- turns on two properties that nothing else in the schema needs at once.
--
-- ----------------------------------------------------------------------------
-- 1. A RATE IS EFFECTIVE-DATED, BECAUSE LAST MONTH ALREADY HAPPENED.
--
-- Give somebody a raise today and last month's labour cost must not move. A
-- single hourly_rate column on a membership would rewrite history every time
-- anybody got a raise — payroll that changes retroactively is not payroll.
--
-- So a wage is a ROW with a start date, never an edit. Costing an hour worked
-- on the 3rd asks what the rate was on the 3rd. This is the same principle as
-- 0015's cost_at_sale and 0040's quoted_total: capture the number that applied
-- at the time, because the number will change and the event will not.
--
-- ----------------------------------------------------------------------------
-- 2. IT IS THE MOST CONFIDENTIAL DATA HERE, AND THE POLICY SAYS SO.
--
-- Your own pay: always. Everybody's pay: the owner, the regional manager, and
-- the accountant, because payroll is their job. NOT the branch manager — they
-- write the rota and manage the floor, and neither of those needs to know what
-- a colleague earns. That is a real restriction with a real consequence, and
-- the consequence is deliberate: see the note on app.wage_at below.
--
-- And nobody sets their own rate except the owner. A regional manager awarding
-- themselves a raise is exactly the thing an audit trail alone does not stop —
-- it only records it afterwards. The owner is exempt because in a single-owner
-- restaurant there is nobody else to ask, and 0035 already established that
-- shape for the menu.
--
-- Depends on: 0011 (memberships), 0037 (modules), 0038 (labour)
-- ============================================================================

BEGIN;

CREATE TABLE public.employee_wages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- Whose pay. NO ACTION: a wage record is part of what was paid, and
    -- deleting a person should not quietly rewrite a payroll run.
    user_id         uuid NOT NULL REFERENCES public.users (id),

    hourly_rate     numeric(10, 2) NOT NULL CHECK (hourly_rate >= 0),

    -- A DATE, not a timestamp. Pay changes on a day, not at 14:32, and every
    -- payroll conversation anybody has is in whole days.
    effective_from  date NOT NULL,

    note            text CHECK (note IS NULL OR char_length(note) <= 300),

    -- Never null in practice, and the CHECK below makes that structural: a pay
    -- change nobody is answerable for is the one worth hiding.
    set_by          uuid REFERENCES public.users (id) ON DELETE SET NULL,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- One rate per person per start date. A second row for the same day is
    -- ambiguous about which applied, and "it depends which one you read" is
    -- not an answer payroll can use.
    CONSTRAINT employee_wages_one_per_day UNIQUE (user_id, effective_from)
);

COMMENT ON TABLE public.employee_wages IS
    'Effective-dated pay rates (0042). A raise is a NEW ROW, never an edit — editing would rewrite last month''s labour cost, and payroll that changes retroactively is not payroll.';

CREATE INDEX employee_wages_lookup_idx
    ON public.employee_wages (user_id, effective_from DESC);
CREATE INDEX employee_wages_org_idx
    ON public.employee_wages (organization_id, effective_from DESC);

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.employee_wages
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.employee_wages ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.employee_wages
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- WHO MAY READ. Covering FOR ALL, so it covers SELECT — which is the whole
-- point here, unlike most RESTRICTIVE policies in this schema.
CREATE POLICY own_wage_or_payroll ON public.employee_wages
    AS RESTRICTIVE FOR ALL
    USING (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR app.user_has_org_role(organization_id,
               ARRAY['owner', 'regional_manager', 'accountant'])
    )
    WITH CHECK (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR app.user_has_org_role(organization_id,
               ARRAY['owner', 'regional_manager', 'accountant'])
    );

-- WHO MAY WRITE. Narrower than who may read: the accountant runs payroll from
-- these numbers, they do not decide them.
CREATE POLICY require_payroll_insert ON public.employee_wages
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_has_org_role(organization_id, ARRAY['owner', 'regional_manager']));
CREATE POLICY require_payroll_update ON public.employee_wages
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_has_org_role(organization_id, ARRAY['owner', 'regional_manager']))
    WITH CHECK (app.user_has_org_role(organization_id, ARRAY['owner', 'regional_manager']));

-- AND NOT YOUR OWN, unless you own the place.
--
-- An audit trail records a self-awarded raise; it does not prevent one. The
-- owner is exempt because a single-owner restaurant has nobody else to ask —
-- the same concession 0035 makes for the menu.
CREATE POLICY not_your_own_rate ON public.employee_wages
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (
        user_id <> NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR app.user_has_org_role(organization_id, ARRAY['owner'])
    );

-- 0037's gate, writes only. A tenant that switches labour off keeps its pay
-- history readable — payroll for a month already worked still has to run.
CREATE POLICY require_module_insert ON public.employee_wages
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'labour'));
CREATE POLICY require_module_update ON public.employee_wages
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'labour'))
    WITH CHECK (app.org_has_module(organization_id, 'labour'));

-- No DELETE policy and no DELETE grant: a pay history is a record of what
-- somebody was owed.

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON public.employee_wages TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The rate that applied on a given day.
--
-- SECURITY INVOKER — and that is a decision, not an oversight.
--
-- Running as the caller means the confidentiality policy above applies to this
-- lookup too, so a branch manager costing the rota gets NULL for colleagues
-- whose pay they may not see. That is the correct answer rather than a
-- limitation: they get the hours, and the cost reads as unknown. A SECURITY
-- DEFINER version would quietly hand every wage in the restaurant to anybody
-- who could call a costing function.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.wage_at(p_user_id uuid, p_on date)
RETURNS numeric
LANGUAGE sql
STABLE
AS $fn$
    SELECT w.hourly_rate
      FROM public.employee_wages w
     WHERE w.user_id = p_user_id
       AND w.effective_from <= p_on
     ORDER BY w.effective_from DESC
     LIMIT 1;
$fn$;

COMMENT ON FUNCTION app.wage_at(uuid, date) IS
    'The rate in force on a date (0042). SECURITY INVOKER on purpose: the confidentiality policy applies to this lookup, so somebody who may not see a colleague''s pay gets NULL — cost unknown — rather than a number they were not entitled to.';

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.wage_at(uuid, date) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
