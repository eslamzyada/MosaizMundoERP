-- ============================================================================
-- Migration 0027: A manager's judgement, beside the measured figures
-- Mosaiz Mundo ERP
--
-- 0026 made performance measurable: orders served, revenue, average order
-- value, void rate. Those are facts, and they are not the whole of anyone's
-- job. A cashier who is calm in a rush, trains the new starter, or notices the
-- fridge is warm produces nothing the till can see.
--
-- This is where a manager records what the numbers cannot. It is deliberately
-- kept SEPARATE from them and never averaged in: combining a fact and an
-- opinion into one score hides which of the two moved it, and the moment
-- someone disputes a number nobody can say whether the machine or the manager
-- produced it.
--
-- ----------------------------------------------------------------------------
-- READS ARE GATED, which is unique in this schema.
--
-- Every other table leaves SELECT open to the organization: an accountant may
-- read stock, a cashier may read the menu, and the 0010 policies restrict only
-- writes. A rating is different in kind — it is one person's judgement of
-- another, and the choice made here is that it is a management record, not
-- feedback the employee receives. So the RESTRICTIVE policy covers SELECT too,
-- and a cashier cannot read ANY rating including their own.
--
-- That is a real cost, stated plainly: someone can be rated poorly for months
-- without being told, and the system now makes that easy. It is a management
-- failure the software cannot prevent, but it should not be dressed up — if
-- the policy later changes to "everyone sees their own", that is a new
-- migration with a second, narrower read policy, not a UI tweak.
--
-- ----------------------------------------------------------------------------
-- ONE RATING PER PERSON PER MONTH, and the month locks.
--
-- A calendar month is the natural review cycle and makes a trend readable; the
-- UNIQUE constraint is what makes "Ahmed's July rating" a question with one
-- answer. While the month is current the rating is editable, because a first
-- impression formed on the 3rd should be revisable on the 28th. Once the month
-- is over it is history and cannot be rewritten — the same principle as
-- cost_at_sale (0015) and the void record (0018).
--
-- The lock is enforced by a TRIGGER, not by the API. A rule that lives only in
-- a controller is a rule that a second caller, a script, or a future endpoint
-- can bypass without noticing.
--
-- NOBODY RATES THEMSELVES. Not a hypothetical: an owner is a member of their
-- own organization and would otherwise appear in their own review list.
--
-- Depends on: 0010 (user_can_administer), 0011 (memberships)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The table.
--
--    period_month is the FIRST DAY of the month it covers, as a date. Storing a
--    date rather than a (year, month) pair keeps comparisons and ordering
--    trivial, and date_trunc makes the "is this the current month" test one
--    expression rather than two.
-- ----------------------------------------------------------------------------
CREATE TABLE public.employee_ratings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    -- Who is being rated. NO ACTION, like served_by (0026): a rating is a record
    -- of a judgement that was made, and it does not stop having been made
    -- because the person left.
    employee_id     uuid NOT NULL REFERENCES public.users (id),
    -- Who made the judgement. Kept so a disputed rating has an author.
    rated_by        uuid REFERENCES public.users (id),

    period_month    date NOT NULL,

    -- 1..5. A small scale on purpose: a 1-10 scale invites false precision,
    -- and nobody can defend the difference between a 6 and a 7.
    score           smallint NOT NULL CHECK (score BETWEEN 1 AND 5),

    -- What the score means. Optional, but a bare number a year later tells
    -- nobody anything, which is why the API nudges towards writing one.
    note            text CHECK (note IS NULL OR char_length(note) <= 1000),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- One verdict per person per month: what makes a trend line meaningful.
    CONSTRAINT employee_ratings_unique_period
        UNIQUE (organization_id, employee_id, period_month),

    -- The date must actually be a month boundary, or "one per month" quietly
    -- becomes "one per day someone happened to pick".
    CONSTRAINT employee_ratings_month_start
        CHECK (period_month = date_trunc('month', period_month)::date),

    -- Rating a month that has not happened yet is not a judgement, it is a
    -- guess. Bounded here rather than in the API for the usual reason.
    CONSTRAINT employee_ratings_not_future
        CHECK (period_month <= date_trunc('month', now())::date),

    -- Nobody rates themselves.
    CONSTRAINT employee_ratings_not_self
        CHECK (employee_id IS DISTINCT FROM rated_by)
);

COMMENT ON TABLE public.employee_ratings IS
    'A manager''s judgement of one employee for one calendar month (0027). Deliberately separate from the measured figures in the employee report and never averaged with them: combining a fact and an opinion hides which one moved the result. Readable only by administrators — unlike every other table here, SELECT is gated.';
COMMENT ON COLUMN public.employee_ratings.period_month IS
    'First day of the month this rating covers. Editable while that month is current, immutable afterwards (enforced by trg_employee_ratings_month_lock).';

CREATE TRIGGER trg_employee_ratings_updated_at
    BEFORE UPDATE ON public.employee_ratings
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- "This person's history" and "everyone for this month" are the two reads.
CREATE INDEX employee_ratings_employee_idx
    ON public.employee_ratings (organization_id, employee_id, period_month DESC);
CREATE INDEX employee_ratings_period_idx
    ON public.employee_ratings (organization_id, period_month DESC);

-- ----------------------------------------------------------------------------
-- 2. The month lock.
--
--    A past month is history. Allowing an edit would let a manager revise last
--    quarter's verdicts after seeing this quarter's numbers, which is exactly
--    the rewriting the rest of this schema refuses.
--
--    Enforced on INSERT as well as UPDATE: back-dating a brand new rating into
--    a closed month is the same act by another route.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.enforce_rating_month_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.period_month <> date_trunc('month', now())::date THEN
        RAISE EXCEPTION
            'rating for % is closed; only the current month can be written'
            , to_char(NEW.period_month, 'YYYY-MM')
            USING ERRCODE = 'object_not_in_prerequisite_state';   -- 55000
    END IF;

    -- The month a rating covers may never move, even within the open month:
    -- that would carry a judgement across periods rather than editing it.
    IF TG_OP = 'UPDATE' AND NEW.period_month IS DISTINCT FROM OLD.period_month THEN
        RAISE EXCEPTION 'a rating cannot be moved to a different month'
            USING ERRCODE = 'object_not_in_prerequisite_state';   -- 55000
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_employee_ratings_month_lock
    BEFORE INSERT OR UPDATE ON public.employee_ratings
    FOR EACH ROW EXECUTE FUNCTION app.enforce_rating_month_lock();

COMMENT ON FUNCTION app.enforce_rating_month_lock() IS
    'Confines writes to the current calendar month (0027). In the database rather than the API because a rule enforced in one controller is bypassed by the next one somebody writes.';

-- ----------------------------------------------------------------------------
-- 3. Tenant isolation, and the read gate.
--    ENABLE, never FORCE — FORCE would break the SECURITY DEFINER helpers.
-- ----------------------------------------------------------------------------
ALTER TABLE public.employee_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.employee_ratings
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- The unusual one: FOR ALL covers SELECT, so this restricts reading as well as
-- writing. Everywhere else in this schema a member of the organization may read
-- what the organization holds; a rating is the exception, by decision.
CREATE POLICY require_admin_access ON public.employee_ratings
    AS RESTRICTIVE FOR ALL
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

-- No DELETE grant: a rating that was made is part of the record, and removing
-- one would be a way to erase a judgement rather than revise it. Note that the
-- FOR ALL permissive policy above WOULD cover DELETE if the privilege were ever
-- granted — see 0014, 0019 and 0024 for the trap this avoids by not granting it.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON public.employee_ratings TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
