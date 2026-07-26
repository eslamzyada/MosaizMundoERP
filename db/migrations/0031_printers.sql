-- ============================================================================
-- Migration 0031: Where a ticket comes out
-- Mosaiz Mundo ERP
--
-- Firing an order tells the kitchen (0029) — but only in the database. In the
-- kitchen itself nothing happens, so the telling is still done by shouting, and
-- an order's notes ("no onions", "nut allergy") survive only as long as somebody
-- remembers them. This records where a ticket should physically print.
--
-- ----------------------------------------------------------------------------
-- WHY THE ADDRESS LIVES HERE AND NOT ON THE TABLET.
--
-- A restaurant with three tills should configure its printer once, not three
-- times, and a tablet that is dropped and replaced should not take the setup
-- with it. So the address is organization data like anything else, and a till
-- reads it the same way it reads the menu.
--
-- ----------------------------------------------------------------------------
-- AT MOST ONE ACTIVE PRINTER PER ROLE.
--
-- "Which printer does this ticket go to?" must have exactly one answer. With
-- two active kitchen printers a till picks whichever it happened to read first,
-- and tickets disappear to a machine nobody is watching — the worst kind of
-- failure, because it looks like it worked. A partial unique index makes the
-- second one impossible rather than merely discouraged.
--
-- Deactivating instead of deleting is what makes that workable: swapping
-- printers is is_active = false on the old row and a new one, in either order.
--
-- ----------------------------------------------------------------------------
-- ROLE, NOT MODEL. The column says what a printer is FOR — the kitchen's ticket
-- or the customer's receipt — because that is the only thing the software has
-- to decide. Which brand it is, and what it can do, is discovered by talking to
-- it, not by being told here.
--
-- READ BY EVERY MEMBER, WRITTEN BY ADMINS. A cashier must read the address to
-- print at all; changing where the kitchen's tickets go is administrative.
-- Note the DELETE gate: user_belongs_to_org is FOR ALL and PERMISSIVE, so
-- granting DELETE without its own RESTRICTIVE policy would let any cashier
-- delete the row (the same trap as 0014, 0019 and 0024).
--
-- Depends on: 0001 (app.set_updated_at), 0010 (role predicates)
-- ============================================================================

BEGIN;

CREATE TABLE public.printers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id),
    -- What a human calls it: "مطبخ", "الكاشير". Shown when a print fails, so it
    -- has to name something findable in the building.
    name            text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 60),
    role            text NOT NULL CHECK (role IN ('kitchen', 'receipt')),
    -- An IP or a hostname. Deliberately text and not inet: plenty of these are
    -- reached by name on a small LAN, and inet would refuse that outright.
    host            text NOT NULL CHECK (length(btrim(host)) > 0 AND length(host) <= 253),
    -- 9100 is the raw-printing port practically every network thermal printer
    -- listens on, so it is the default rather than something to look up.
    port            integer NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.printers IS
    'Network thermal printers, by what they are FOR (0031). Held per organization rather than per device so a restaurant configures its printer once and a replaced tablet does not lose it.';
COMMENT ON COLUMN public.printers.role IS
    'kitchen = the ticket the cooks work from; receipt = the customer bill. Exactly one of each may be active at a time.';
COMMENT ON COLUMN public.printers.host IS
    'IP or hostname on the local network. The till connects to it directly; the API gateway never does, and on a tunnelled backend it could not.';

-- The rule that makes routing answerable. Partial, so retired printers can pile
-- up harmlessly — is_active = false is how a printer is replaced.
CREATE UNIQUE INDEX printers_one_active_per_role
    ON public.printers (organization_id, role)
    WHERE is_active;

COMMENT ON INDEX public.printers_one_active_per_role IS
    'At most one active printer per role per organization: with two, a till picks arbitrarily and tickets vanish to a machine nobody is watching.';

CREATE TRIGGER trg_printers_updated_at
    BEFORE UPDATE ON public.printers
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: the house convention — ENABLE (never FORCE, which breaks the SECURITY
-- DEFINER helpers), a permissive org-membership policy, and RESTRICTIVE gates
-- for each privilege that is not everyone's.
-- ----------------------------------------------------------------------------
ALTER TABLE public.printers ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.printers
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

CREATE POLICY require_admin_insert ON public.printers
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.printers
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_delete ON public.printers
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.printers TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
