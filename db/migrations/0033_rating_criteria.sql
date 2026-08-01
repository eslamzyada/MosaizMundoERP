-- ============================================================================
-- Migration 0033: What, exactly, is being judged
-- Mosaiz Mundo ERP
--
-- 0027 gave a manager one number per person per month and a note to explain it.
-- That is enough to record an opinion and not enough to act on one: "3 out of
-- 5" tells an employee nothing about what to do differently, and tells the next
-- manager nothing about what the last one cared about.
--
-- This adds the rubric. An organization keeps its own list of criteria, and a
-- monthly review records a score against each. The overall rating from 0027
-- stays exactly as it was and is NOT computed from these — see below.
--
-- ----------------------------------------------------------------------------
-- THE OVERALL SCORE IS STILL THE MANAGER'S, NOT AN AVERAGE.
--
-- The obvious move is to make employee_ratings.score the weighted mean of the
-- criteria. It is rejected for the same reason 0027 refused to average the
-- manager's judgement with the till's figures: an average hides which part
-- moved it, and it quietly turns "how is this person doing" into an arithmetic
-- identity that nobody can disagree with. A manager who scores every criterion
-- a 4 and still thinks somebody is struggling is telling you something real,
-- and the schema should let them say it.
--
-- The weighted average IS computed and reported — beside the overall score,
-- never instead of it. Where the two disagree is the interesting part of a
-- review, so the disagreement is preserved rather than defined away.
--
-- ----------------------------------------------------------------------------
-- THE RUBRIC IS READABLE BY EVERYONE. THE SCORES ARE NOT.
--
-- 0027 gated SELECT on ratings, and flagged the cost of that plainly: someone
-- can be rated poorly for months without being told. That gate stays for the
-- scores, which are judgements of a named person.
--
-- The criteria are a different kind of thing — they are the standard, not the
-- verdict — so they are readable by every member of the organization and
-- writable only by administrators. Knowing what you are assessed on is not
-- privileged information, and a rubric nobody may read is a rubric nobody can
-- meet.
--
-- ----------------------------------------------------------------------------
-- A SCORE'S CRITERION MUST BELONG TO THE SAME RESTAURANT.
--
-- Enforced by a COMPOSITE foreign key on (criterion_id, organization_id), not
-- by criterion_id alone. RLS would hide another organization's criterion from a
-- query, but hiding is not the same as forbidding: a SECURITY DEFINER
-- procedure, a migration, or a superuser script all run outside it, and a score
-- pointing at a foreign rubric row is a cross-tenant reference that no policy
-- would ever surface. The constraint is the boundary; RLS is the filter.
--
-- Depends on: 0010 (user_can_administer), 0011 (memberships), 0027 (month lock)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The criteria — one organization's list of what it assesses.
-- ----------------------------------------------------------------------------
CREATE TABLE public.rating_criteria (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    name            text NOT NULL,
    -- What a 5 looks like, in words. Optional, but a criterion called "الجودة"
    -- means whatever each manager decides it means until somebody writes it
    -- down.
    description     text,

    -- How much this counts towards the reported average. A restaurant that
    -- cares twice as much about food safety as about tidiness can say so.
    weight          numeric(4,2) NOT NULL DEFAULT 1,

    -- Retired rather than deleted once it has been scored: the history has to
    -- keep meaning what it meant.
    is_active       boolean NOT NULL DEFAULT true,
    -- The order the review sheet is laid out in, so it reads the way the
    -- manager thinks rather than alphabetically.
    sort_order      smallint NOT NULL DEFAULT 0,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT rating_criteria_name_check
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    CONSTRAINT rating_criteria_description_check
        CHECK (description IS NULL OR char_length(description) <= 500),
    -- Zero would make a criterion invisible in the average while still being
    -- scored, which is a confusing way to say "retired".
    CONSTRAINT rating_criteria_weight_check
        CHECK (weight > 0 AND weight <= 10),

    -- The composite key the scores hang off. Its only job is to let a foreign
    -- key carry organization_id along with the id.
    CONSTRAINT rating_criteria_org_unique UNIQUE (id, organization_id)
);

-- Two criteria whose names differ only by case or spacing make a review sheet
-- ambiguous and a report double-count. Compared normalised, so "الجودة " and
-- "الجودة" collide the way a reader would expect them to.
CREATE UNIQUE INDEX rating_criteria_name_unique
    ON public.rating_criteria (organization_id, lower(btrim(name)));

CREATE INDEX rating_criteria_active_idx
    ON public.rating_criteria (organization_id, is_active, sort_order);

COMMENT ON TABLE public.rating_criteria IS
    'What an organization assesses its people on (0033). Readable by every member — a rubric nobody may read is a rubric nobody can meet — and writable only by administrators.';
COMMENT ON COLUMN public.rating_criteria.weight IS
    'Relative importance in the reported weighted average. Never used to overwrite the manager''s overall score from 0027.';

CREATE TRIGGER trg_rating_criteria_updated_at
    BEFORE UPDATE ON public.rating_criteria
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. The scores — one per person, per month, per criterion.
-- ----------------------------------------------------------------------------
CREATE TABLE public.employee_criterion_scores (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- NO ACTION, like 0026 and 0027: a judgement that was made does not stop
    -- having been made because the person left.
    employee_id     uuid NOT NULL REFERENCES public.users (id),
    rated_by        uuid REFERENCES public.users (id),

    criterion_id    uuid NOT NULL,
    period_month    date NOT NULL,

    -- The same 1..5 scale as the overall rating. A different scale here would
    -- make the two incomparable on the one screen that shows them together.
    score           smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
    note            text CHECK (note IS NULL OR char_length(note) <= 500),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- The composite FK. Not CASCADE: deleting a criterion that has been scored
    -- would silently rewrite completed reviews, so it is refused and the
    -- criterion is retired instead.
    --
    -- NO ACTION rather than RESTRICT, which is the difference between a rule
    -- and a deadlock. RESTRICT is checked IMMEDIATELY, so dropping an
    -- organization — which cascades to both tables — would fail whenever
    -- Postgres happened to remove the criteria before the scores that point at
    -- them. NO ACTION defers the check to the end of the statement, by which
    -- time both sets are gone. A lone criterion with scores is still refused.
    CONSTRAINT employee_criterion_scores_criterion_fkey
        FOREIGN KEY (criterion_id, organization_id)
        REFERENCES public.rating_criteria (id, organization_id)
        ON DELETE NO ACTION,

    CONSTRAINT employee_criterion_scores_unique
        UNIQUE (organization_id, employee_id, period_month, criterion_id),

    CONSTRAINT employee_criterion_scores_month_start
        CHECK (period_month = date_trunc('month', period_month)::date),
    CONSTRAINT employee_criterion_scores_not_future
        CHECK (period_month <= date_trunc('month', now())::date),
    CONSTRAINT employee_criterion_scores_not_self
        CHECK (employee_id IS DISTINCT FROM rated_by)
);

COMMENT ON TABLE public.employee_criterion_scores IS
    'One score per person, per month, per criterion (0033). Beside the overall rating from 0027, never averaged into it. SELECT is gated to administrators, like the rating itself.';

CREATE TRIGGER trg_employee_criterion_scores_updated_at
    BEFORE UPDATE ON public.employee_criterion_scores
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- The same month lock as the overall rating, and deliberately the SAME
-- function: two copies of this rule would be two chances for a future edit to
-- change one and not the other, leaving a review half-open.
CREATE TRIGGER trg_employee_criterion_scores_month_lock
    BEFORE INSERT OR UPDATE ON public.employee_criterion_scores
    FOR EACH ROW EXECUTE FUNCTION app.enforce_rating_month_lock();

CREATE INDEX employee_criterion_scores_employee_idx
    ON public.employee_criterion_scores (organization_id, employee_id, period_month DESC);
CREATE INDEX employee_criterion_scores_period_idx
    ON public.employee_criterion_scores (organization_id, period_month DESC);
CREATE INDEX employee_criterion_scores_criterion_idx
    ON public.employee_criterion_scores (criterion_id);

-- ----------------------------------------------------------------------------
-- 3. Isolation and gates.
--    ENABLE, never FORCE — FORCE breaks the SECURITY DEFINER helpers.
-- ----------------------------------------------------------------------------
ALTER TABLE public.rating_criteria ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.rating_criteria
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Gated PER COMMAND, not FOR ALL: a FOR ALL restrictive policy would gate
-- SELECT too, and the whole point of this table is that the standard is
-- readable by the people held to it.
--
-- DELETE gets its own policy for the reason 0014, 0019, 0024, 0031 and 0032 all
-- learned the hard way: the PERMISSIVE FOR ALL policy above already covers
-- DELETE, so granting the privilege without a RESTRICTIVE gate would let any
-- member remove a criterion.
CREATE POLICY require_admin_insert ON public.rating_criteria
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.rating_criteria
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_delete ON public.rating_criteria
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

ALTER TABLE public.employee_criterion_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.employee_criterion_scores
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- FOR ALL here, which covers SELECT: this is a judgement of a named person and
-- follows the 0027 decision exactly. No DELETE privilege is granted below, so
-- the fact that this covers DELETE too costs nothing.
CREATE POLICY require_admin_access ON public.employee_criterion_scores
    AS RESTRICTIVE FOR ALL
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        -- DELETE is granted on the criteria so a criterion added by mistake
        -- this morning can be removed; the FK RESTRICT above is what stops one
        -- that has been scored from going anywhere.
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.rating_criteria TO mosaiz_app_user;
        -- No DELETE on the scores: a score that was given is part of the
        -- record, exactly as in 0027.
        GRANT SELECT, INSERT, UPDATE ON public.employee_criterion_scores TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. A rubric every organization already has.
--
--    An empty list is a feature nobody discovers: the review screen would show
--    "no criteria yet" and the manager would have to invent five before they
--    could score anybody. These five are ordinary restaurant standards and are
--    ordinary rows — renameable, reweightable, retirable. They are the ones the
--    custom criteria are added BESIDE.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.seed_default_rating_criteria(p_organization_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.rating_criteria (organization_id, name, description, sort_order)
    VALUES
        (p_organization_id, 'الالتزام بالمواعيد',
         'الحضور في الموعد والبقاء حتى نهاية الوردية', 1),
        (p_organization_id, 'جودة الخدمة',
         'التعامل مع العملاء ودقة تنفيذ الطلبات', 2),
        (p_organization_id, 'النظافة والمعايير',
         'نظافة محطة العمل والالتزام بمعايير سلامة الغذاء', 3),
        (p_organization_id, 'العمل ضمن الفريق',
         'المساعدة عند الضغط ونقل الخبرة للزملاء', 4),
        (p_organization_id, 'سرعة الإنجاز',
         'إنجاز المهام في وقتها دون تأثير على الجودة', 5)
    -- Idempotent: the trigger below and the backfill after it must not fight
    -- over an organization created while this migration runs.
    ON CONFLICT DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.seed_default_rating_criteria(uuid) FROM PUBLIC;

COMMENT ON FUNCTION app.seed_default_rating_criteria(uuid) IS
    'Gives one organization the default review rubric (0033). SECURITY DEFINER because it runs before the creator has a membership, so the admin write policy would otherwise refuse it.';

-- Every organization that exists today.
DO $$
DECLARE
    org record;
BEGIN
    FOR org IN SELECT id FROM public.organizations LOOP
        PERFORM app.seed_default_rating_criteria(org.id);
    END LOOP;
END;
$$;

-- ...and every one created from now on. A trigger rather than a line in the
-- signup controller: an organization can be created by the webhook, by a
-- procedure, or by a script, and only one of those would have remembered.
CREATE FUNCTION app.seed_rating_criteria_on_new_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM app.seed_default_rating_criteria(NEW.id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_organizations_seed_rating_criteria
    AFTER INSERT ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION app.seed_rating_criteria_on_new_org();

COMMIT;
