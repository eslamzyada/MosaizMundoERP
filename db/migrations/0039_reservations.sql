-- ============================================================================
-- Migration 0039: Tables, and booking them
-- Mosaiz Mundo ERP
--
-- This system has never had a table. The floor screen shows OPEN TABS, and an
-- order carries no reference to where it was served — which is workable for a
-- till and hopeless for a restaurant that takes bookings, because "table 7 at
-- eight" needs a table 7 to exist before anybody can promise it.
--
-- So two things, in order: the tables themselves, then the promises made about
-- them.
--
-- ----------------------------------------------------------------------------
-- THE ONE RULE THAT MATTERS: A TABLE IS PROMISED TO ONE PARTY AT A TIME.
--
-- Double-booking is the failure this exists to prevent, and it is not a
-- validation — it is an EXCLUDE constraint. Two hosts taking bookings on two
-- phones at the same second is exactly the case a check-then-insert loses, and
-- the customer who arrives to find their table occupied does not care which
-- request won.
--
-- The constraint covers only bookings that are still promises: a cancelled or
-- finished sitting releases the table, and a partial index expresses that
-- rather than a status column being consulted by hand everywhere.
--
-- ----------------------------------------------------------------------------
-- WHAT A RESERVATION HOLDS ABOUT A MEMBER OF THE PUBLIC.
--
-- A name and a phone number, because a restaurant cannot hold a table without
-- them, and NOTHING else. No email, no address, no history, no "preferences".
-- Every additional field is a thing that leaks if this database ever does, and
-- the guest never agreed to any of it. Whoever adds the next column here should
-- have to justify it against that sentence.
--
-- Depends on: 0001 (organizations), 0010 (roles), 0037 (modules)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- The floor plan.
-- ----------------------------------------------------------------------------
CREATE TABLE public.restaurant_tables (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- What the staff call it. Not a number: real floors have "شرفة ٣" and "بار".
    label           text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 40),
    -- Where it is — terrace, hall, upstairs. Optional, because a small place
    -- has one room and naming it is noise.
    area            text CHECK (area IS NULL OR char_length(btrim(area)) <= 40),
    seats           integer NOT NULL DEFAULT 2 CHECK (seats BETWEEN 1 AND 40),

    -- Retired rather than deleted: a table that has held bookings is part of
    -- the record of them.
    is_active       boolean NOT NULL DEFAULT true,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- Two tables called "5" in one restaurant is a mistake every time.
    CONSTRAINT restaurant_tables_label_unique UNIQUE (organization_id, label)
);

COMMENT ON TABLE public.restaurant_tables IS
    'The floor plan (0039). The first time this system has had a table at all — the floor screen shows open tabs, and orders carry no table reference.';

-- The composite target that lets anything referencing a table prove, in the
-- foreign key itself, that it belongs to the same tenant.
CREATE UNIQUE INDEX restaurant_tables_tenant_key
    ON public.restaurant_tables (id, organization_id);

CREATE INDEX restaurant_tables_org_idx
    ON public.restaurant_tables (organization_id) WHERE is_active;

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.restaurant_tables
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.restaurant_tables
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- The floor plan is management's to define; everyone reads it, because a
-- waiter seating a guest needs to know what exists.
CREATE POLICY require_admin_insert ON public.restaurant_tables
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));
CREATE POLICY require_admin_update ON public.restaurant_tables
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_module_insert ON public.restaurant_tables
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'reservations'));
CREATE POLICY require_module_update ON public.restaurant_tables
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'reservations'))
    WITH CHECK (app.org_has_module(organization_id, 'reservations'));

-- No DELETE policy and no DELETE grant: tables are retired with is_active,
-- because deleting one would orphan the bookings that explain a night's covers.

-- ----------------------------------------------------------------------------
-- The promises.
-- ----------------------------------------------------------------------------
CREATE TABLE public.reservations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- Composite FK: a booking cannot point at another restaurant's table, and
    -- that is proven by the key rather than by a policy remembering to check.
    table_id        uuid NOT NULL,

    guest_name      text NOT NULL CHECK (char_length(btrim(guest_name)) BETWEEN 2 AND 80),
    -- The only other thing held about a member of the public. See the header.
    guest_phone     text CHECK (guest_phone IS NULL OR char_length(btrim(guest_phone)) BETWEEN 5 AND 20),
    party_size      integer NOT NULL CHECK (party_size BETWEEN 1 AND 40),

    starts_at       timestamptz NOT NULL,
    ends_at         timestamptz NOT NULL,

    status          text NOT NULL DEFAULT 'booked'
                    CHECK (status IN ('booked', 'seated', 'completed', 'no_show', 'cancelled')),

    note            text CHECK (note IS NULL OR char_length(note) <= 500),

    created_by      uuid REFERENCES public.users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reservations_end_after_start CHECK (ends_at > starts_at),
    -- A sitting, not a lease.
    CONSTRAINT reservations_sane_length CHECK (ends_at - starts_at <= interval '8 hours'),

    CONSTRAINT reservations_table_same_tenant
        FOREIGN KEY (table_id, organization_id)
        REFERENCES public.restaurant_tables (id, organization_id),

    -- THE rule. A table is promised to one party at a time — and only while the
    -- promise stands: cancelled, finished and no-show sittings release it.
    CONSTRAINT reservations_no_double_booking
        EXCLUDE USING gist (
            table_id WITH =,
            tstzrange(starts_at, ends_at, '[)') WITH &&
        ) WHERE (status IN ('booked', 'seated'))
);

COMMENT ON TABLE public.reservations IS
    'Bookings (0039). Double-booking is refused by an EXCLUDE constraint rather than validated: two hosts on two phones is exactly the case a check-then-insert loses, and the guest who arrives to find their table taken does not care which request won.';

CREATE INDEX reservations_service_idx
    ON public.reservations (organization_id, starts_at);
CREATE INDEX reservations_table_idx
    ON public.reservations (table_id, starts_at DESC);

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.reservations
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.reservations
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Taking a booking is floor work, not administration: the person answering the
-- phone is whoever is nearest it. app.user_can_sell is the existing name for
-- "works here in an operational capacity" — everyone except the accountant,
-- who is read-only.
CREATE POLICY require_floor_insert ON public.reservations
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_sell(organization_id));
CREATE POLICY require_floor_update ON public.reservations
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_sell(organization_id))
    WITH CHECK (app.user_can_sell(organization_id));

CREATE POLICY require_module_insert ON public.reservations
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'reservations'));
CREATE POLICY require_module_update ON public.reservations
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'reservations'))
    WITH CHECK (app.org_has_module(organization_id, 'reservations'));

-- No DELETE anywhere. A booking that did not happen is 'cancelled' or
-- 'no_show' — both of which a restaurant needs to be able to count. Deleting
-- it destroys the only evidence of a table that sat empty.

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON public.restaurant_tables TO mosaiz_app_user;
        GRANT SELECT, INSERT, UPDATE ON public.reservations TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Is this table free?
--
-- The question a host asks before promising anything. Exposed as a function so
-- the answer comes from the same predicate as the constraint — a UI that
-- computes availability its own way will eventually disagree with the database,
-- and the disagreement will surface as a guest standing in the doorway.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.table_is_free(
    p_table_id  uuid,
    p_starts_at timestamptz,
    p_ends_at   timestamptz,
    p_ignore_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM public.reservations r
         WHERE r.table_id = p_table_id
           AND r.status IN ('booked', 'seated')
           AND (p_ignore_id IS NULL OR r.id <> p_ignore_id)
           AND tstzrange(r.starts_at, r.ends_at, '[)')
               && tstzrange(p_starts_at, p_ends_at, '[)')
    );
$$;

COMMENT ON FUNCTION app.table_is_free(uuid, timestamptz, timestamptz, uuid) IS
    'Whether a table is unpromised for a window (0039). Shares its predicate with the EXCLUDE constraint on purpose: an availability check that disagrees with the constraint is a guest in the doorway.';

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.table_is_free(uuid, timestamptz, timestamptz, uuid) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The module. Off by default, like labour: a new capability is met by choosing
-- it, not by finding it already in the sidebar.
-- ----------------------------------------------------------------------------
INSERT INTO public.modules (key, name_ar, description_ar, depends_on, enforced_in, default_enabled, sort_order)
VALUES ('reservations', 'الحجوزات', 'الطاولات وحجزها للضيوف',
        '{}', 'database', false, 45);

COMMIT;
