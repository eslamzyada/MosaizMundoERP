-- ============================================================================
-- Migration 0038: Labour — who is working, and who actually worked
-- Mosaiz Mundo ERP
--
-- Every buyer's guide for restaurant software names three pillars: sales,
-- stock, and labour. This system has had the first two since 0004 and 0005.
-- Labour is the other half of a restaurant's controllable cost, and until now
-- there has been nothing — the roster in 0011 says who EXISTS, not who is on
-- tonight or who stayed late.
--
-- ----------------------------------------------------------------------------
-- TWO TABLES, AND THEY ARE NOT THE SAME KIND OF THING.
--
--   shifts       — what was PLANNED. A manager writes it, everyone reads it,
--                  and it can be changed right up until it happens.
--   time_entries — what HAPPENED. Nobody writes it directly. Not the manager,
--                  and emphatically not the person it is about.
--
-- The second is the whole point of the migration. A time record that the
-- person it describes can edit is not a time record, it is a claim — and
-- payroll built on a claim is payroll built on trust alone. So the application
-- role gets NO INSERT and NO UPDATE on time_entries at all. Clocking in and
-- out happens through SECURITY DEFINER procedures that stamp the time from
-- the server clock, and a manager correcting a forgotten clock-out has to say
-- so in a column that keeps their name.
--
-- ----------------------------------------------------------------------------
-- A NOTE ON SECURITY DEFINER AND THE MODULE GATE.
--
-- The RESTRICTIVE module policies from 0037 do NOT protect the procedures
-- below: SECURITY DEFINER runs as the owner, and the owner is not subject to
-- RLS. So each procedure asks app.org_has_module() itself, explicitly. A
-- module gate that only covers the paths which happen to go through RLS is a
-- module gate with a hole in it.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
-- No wages, and therefore no labour COST. Hours are the foundation and the
-- honest first half; pay rates are salary data with their own confidentiality
-- rules, and bolting them onto this migration would mean designing that in a
-- hurry. Hours first, cost when it can be given the same care as the rest.
--
-- Depends on: 0011 (memberships), 0010 (roles), 0037 (modules)
-- ============================================================================

BEGIN;

-- Needed so one GiST exclusion constraint can mix uuid equality with a range
-- overlap. Without it "the same person cannot be on two shifts at once" would
-- have to be a trigger, which two concurrent writers can slip past.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ----------------------------------------------------------------------------
-- The plan.
-- ----------------------------------------------------------------------------
CREATE TABLE public.shifts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- Whose shift. NO ACTION rather than CASCADE: a schedule is a record of
    -- what was planned, and deleting a person should not quietly rewrite last
    -- month's rota. Deactivating a membership is how somebody leaves.
    user_id         uuid NOT NULL REFERENCES public.users (id),

    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,
    note            text CHECK (note IS NULL OR char_length(note) <= 500),

    created_by      uuid REFERENCES public.users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT shifts_end_after_start CHECK (ends_at > starts_at),
    -- A shift longer than a day is a data-entry slip, not a rota.
    CONSTRAINT shifts_sane_length CHECK (ends_at - starts_at <= interval '24 hours'),

    -- Nobody is in two places at once. An EXCLUDE constraint rather than a
    -- trigger, because two managers scheduling the same person at the same
    -- moment is exactly the case a trigger misses.
    CONSTRAINT shifts_no_overlap
        EXCLUDE USING gist (
            user_id WITH =,
            tstzrange(starts_at, ends_at, '[)') WITH &&
        )
);

COMMENT ON TABLE public.shifts IS
    'The rota (0038): what was planned. Managers write it, everybody reads it — a schedule nobody can see is a schedule nobody follows.';

CREATE INDEX shifts_org_window_idx ON public.shifts (organization_id, starts_at);
CREATE INDEX shifts_user_window_idx ON public.shifts (user_id, starts_at DESC);

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.shifts
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.shifts
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Reading the rota is not restricted beyond the organization. In a real
-- restaurant it is a sheet of paper on the wall, and a waiter needs to know
-- who else is on tonight to know who to hand a table to.
CREATE POLICY require_admin_insert ON public.shifts
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));
CREATE POLICY require_admin_update ON public.shifts
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));
CREATE POLICY require_admin_delete ON public.shifts
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

-- 0037's gate, per command. A tenant that stops running labour keeps its rota
-- history readable and simply cannot add to it.
CREATE POLICY require_module_insert ON public.shifts
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'labour'));
CREATE POLICY require_module_update ON public.shifts
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'labour'))
    WITH CHECK (app.org_has_module(organization_id, 'labour'));
CREATE POLICY require_module_delete ON public.shifts
    AS RESTRICTIVE FOR DELETE
    USING (app.org_has_module(organization_id, 'labour'));

-- ----------------------------------------------------------------------------
-- What happened.
-- ----------------------------------------------------------------------------
CREATE TABLE public.time_entries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES public.users (id),

    -- The shift this was worked against, when there was one. Null is normal:
    -- somebody covering at short notice is still working.
    shift_id        uuid REFERENCES public.shifts (id) ON DELETE SET NULL,

    -- Stamped by the server, never sent by the client. A clock whose time the
    -- client chooses is a clock that reads whatever the client wants.
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,

    -- A correction, and who is answerable for it. Not nullable-and-forgotten:
    -- the CHECK below makes an amendment without a reason impossible.
    amended_by      uuid REFERENCES public.users (id) ON DELETE SET NULL,
    amended_at      timestamptz,
    amendment_reason text CHECK (amendment_reason IS NULL OR char_length(btrim(amendment_reason)) BETWEEN 3 AND 500),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT time_entries_end_after_start CHECK (ended_at IS NULL OR ended_at > started_at),
    CONSTRAINT time_entries_amendment_is_attributable CHECK (
        (amended_by IS NULL AND amended_at IS NULL AND amendment_reason IS NULL)
        OR (amended_by IS NOT NULL AND amended_at IS NOT NULL AND amendment_reason IS NOT NULL)
    )
);

COMMENT ON TABLE public.time_entries IS
    'What was actually worked (0038). The application role has NO INSERT and NO UPDATE: a time record its own subject can edit is a claim, not a record. Written only by app.clock_in / app.clock_out / app.amend_time_entry.';

-- One open entry per person, enforced by the database rather than by a check
-- the procedure could forget: a second clock-in without a clock-out would
-- otherwise silently start a parallel day.
CREATE UNIQUE INDEX time_entries_one_open_per_user
    ON public.time_entries (user_id)
    WHERE ended_at IS NULL;

CREATE INDEX time_entries_org_window_idx ON public.time_entries (organization_id, started_at DESC);
CREATE INDEX time_entries_user_window_idx ON public.time_entries (user_id, started_at DESC);

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.time_entries
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.time_entries
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Your own hours are yours to see. Everybody's hours are a manager's business —
-- and the accountant's, because this is what payroll is eventually built from.
-- A waiter reading a colleague's exact comings and goings is not.
CREATE POLICY own_row_or_manager ON public.time_entries
    AS RESTRICTIVE FOR ALL
    USING (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR app.user_has_org_role(organization_id,
               ARRAY['owner', 'regional_manager', 'branch_manager', 'accountant'])
    )
    WITH CHECK (
        user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        OR app.user_has_org_role(organization_id,
               ARRAY['owner', 'regional_manager', 'branch_manager', 'accountant'])
    );

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.shifts TO mosaiz_app_user;
        -- SELECT only. Everything that writes here is a procedure below.
        GRANT SELECT ON public.time_entries TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The clock.
-- ----------------------------------------------------------------------------

/**
 * Starts the caller's working period. Returns the entry id.
 *
 * The organization is derived from the caller's own active membership rather
 * than accepted as an argument — an argument would let a client clock in
 * somewhere it does not work.
 */
CREATE FUNCTION app.clock_in(p_shift_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_org    uuid;
    v_id     uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'no authenticated user' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT m.organization_id INTO v_org
      FROM public.organization_memberships m
     WHERE m.user_id = v_caller AND m.is_active
     ORDER BY m.created_at ASC
     LIMIT 1;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'no active membership' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- SECURITY DEFINER bypasses RLS, so the module gate has to be asked here.
    IF NOT app.org_has_module(v_org, 'labour') THEN
        RAISE EXCEPTION 'this restaurant does not run the labour module'
            USING ERRCODE = 'feature_not_supported';                    -- 0A000
    END IF;

    IF p_shift_id IS NOT NULL AND NOT EXISTS (
        SELECT FROM public.shifts s
         WHERE s.id = p_shift_id AND s.organization_id = v_org AND s.user_id = v_caller
    ) THEN
        RAISE EXCEPTION 'that shift is not yours' USING ERRCODE = 'insufficient_privilege';
    END IF;

    INSERT INTO public.time_entries (organization_id, user_id, shift_id)
    VALUES (v_org, v_caller, p_shift_id)
    RETURNING id INTO v_id;

    RETURN v_id;
EXCEPTION
    -- The partial unique index. Answered as its own sentence, because "you are
    -- already clocked in" and "something went wrong" send people to different
    -- places.
    WHEN unique_violation THEN
        RAISE EXCEPTION 'you are already clocked in'
            USING ERRCODE = 'object_not_in_prerequisite_state';         -- 55000
END;
$$;

/** Ends the caller's open period. Returns the minutes worked. */
CREATE FUNCTION app.clock_out()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller  uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_id      uuid;
    v_started timestamptz;
    v_org     uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'no authenticated user' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT t.id, t.started_at, t.organization_id INTO v_id, v_started, v_org
      FROM public.time_entries t
     WHERE t.user_id = v_caller AND t.ended_at IS NULL;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'you are not clocked in'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NOT app.org_has_module(v_org, 'labour') THEN
        RAISE EXCEPTION 'this restaurant does not run the labour module'
            USING ERRCODE = 'feature_not_supported';
    END IF;

    UPDATE public.time_entries SET ended_at = now() WHERE id = v_id;

    RETURN GREATEST(0, (EXTRACT(EPOCH FROM (now() - v_started)) / 60)::integer);
END;
$$;

/**
 * A manager fixing a forgotten clock-out.
 *
 * Requires a reason, and stamps who gave it. Somebody WILL forget to clock out;
 * the question is only whether the correction leaves a trace.
 */
CREATE FUNCTION app.amend_time_entry(
    p_entry_id   uuid,
    p_started_at timestamptz,
    p_ended_at   timestamptz,
    p_reason     text
)
-- Returns the entry it amended rather than void: a void-returning function is
-- awkward to call from the gateway (Prisma cannot deserialise the column), and
-- echoing the id back is more useful than nothing at all.
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_entry  public.time_entries;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'no authenticated user' USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_entry FROM public.time_entries WHERE id = p_entry_id;
    IF v_entry.id IS NULL THEN
        RAISE EXCEPTION 'no such time entry' USING ERRCODE = 'no_data_found';
    END IF;

    IF NOT app.user_can_administer(v_entry.organization_id) THEN
        RAISE EXCEPTION 'only a manager may amend a time entry'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT app.org_has_module(v_entry.organization_id, 'labour') THEN
        RAISE EXCEPTION 'this restaurant does not run the labour module'
            USING ERRCODE = 'feature_not_supported';
    END IF;

    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
        RAISE EXCEPTION 'an amendment needs a reason'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_ended_at IS NOT NULL AND p_ended_at <= p_started_at THEN
        RAISE EXCEPTION 'a shift cannot end before it starts'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    UPDATE public.time_entries
       SET started_at       = p_started_at,
           ended_at         = p_ended_at,
           amended_by       = v_caller,
           amended_at       = now(),
           amendment_reason = btrim(p_reason)
     WHERE id = p_entry_id;

    RETURN p_entry_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.clock_in(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.clock_out() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.amend_time_entry(uuid, timestamptz, timestamptz, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.clock_in(uuid) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.clock_out() TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.amend_time_entry(uuid, timestamptz, timestamptz, text) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The module itself. default_enabled = false, unlike everything in 0037.
--
-- Those modules described capabilities the tenant was ALREADY using, so
-- defaulting them off would have taken away working features. This is a new
-- capability nobody has yet, and a restaurant should meet it by choosing it —
-- not by discovering a rota screen it never asked for.
-- ----------------------------------------------------------------------------
INSERT INTO public.modules (key, name_ar, description_ar, depends_on, enforced_in, default_enabled, sort_order)
VALUES ('labour', 'الورديات والحضور', 'جدول الورديات وتسجيل الحضور والانصراف',
        '{}', 'database', false, 55);

COMMENT ON FUNCTION app.clock_in(uuid) IS
    'Starts the caller''s working period (0038). SECURITY DEFINER because the application role has no INSERT on time_entries at all — and it asks org_has_module itself, since running as the owner means RLS, and therefore 0037''s module gate, does not apply.';

COMMIT;
