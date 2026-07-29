-- ============================================================================
-- Migration 0032: How the software looks to the person using it
-- Mosaiz Mundo ERP
--
-- Two different kinds of setting, deliberately kept in two tables because they
-- answer to different people:
--
--   user_preferences        MINE. Theme and text size are about one person's
--                           eyes and one person's screen. Nobody else's opinion
--                           applies, including their manager's.
--
--   organization_branding   OURS. The logo is the restaurant's identity and
--                           appears on what customers see, so changing it is an
--                           administrative act like changing the menu.
--
-- Collapsing them into one table would mean either letting a cashier change the
-- restaurant's logo, or letting an owner dictate a cashier's text size. Both
-- are wrong, and no single policy could express both at once.
--
-- ----------------------------------------------------------------------------
-- WHY PREFERENCES ARE STILL ORGANIZATION-SCOPED.
--
-- A preference is genuinely about a PERSON, so (organization_id, user_id) looks
-- redundant. It is kept because the house rule is that every operational table
-- carries organization_id and the user_belongs_to_org policy — and because the
-- alternative leaks: a table keyed on user_id alone is one forgotten predicate
-- away from letting any authenticated caller read rows belonging to people in
-- other restaurants. The org column costs a join key and removes that class of
-- mistake entirely.
--
-- On top of the usual org policy sits a RESTRICTIVE one that limits every row
-- to its OWN user. Both must pass, so a manager cannot read — let alone
-- change — what somebody else finds comfortable to look at.
--
-- ----------------------------------------------------------------------------
-- TEXT SIZE IS A PERCENTAGE, NOT A LIST.
--
-- Stored as an integer scale (100 = default) rather than 'small'/'medium'/
-- 'large', because the UI multiplies a root font size by it. A named list would
-- have to be translated into numbers somewhere anyway, and that somewhere would
-- disagree with itself the first time a fourth size was added.
--
-- Depends on: 0001 (app.set_updated_at), 0010 (role predicates)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. What one person prefers to look at.
-- ----------------------------------------------------------------------------
CREATE TABLE public.user_preferences (
    organization_id uuid NOT NULL REFERENCES public.organizations (id),
    user_id         uuid NOT NULL REFERENCES public.users (id),

    -- 'system' follows the operating system and is the default, because the
    -- right answer for most people is the one they already chose elsewhere.
    theme           text NOT NULL DEFAULT 'system'
                    CHECK (theme IN ('light', 'dark', 'system')),

    -- Percent of the base size. Bounded because below ~80 the interface stops
    -- being readable and above ~200 it stops fitting, and a stored value the UI
    -- refuses to honour is worse than one it never accepted.
    text_scale      smallint NOT NULL DEFAULT 100
                    CHECK (text_scale BETWEEN 80 AND 200),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (organization_id, user_id)
);

COMMENT ON TABLE public.user_preferences IS
    'One person''s appearance settings (0032). Organization-scoped for isolation, but restricted to the owning user: a manager can neither read nor change what somebody else finds comfortable.';
COMMENT ON COLUMN public.user_preferences.text_scale IS
    'Percent of the base font size (100 = default). A number rather than a named size, because the UI multiplies by it and a name would have to become a number somewhere anyway.';

CREATE TRIGGER trg_user_preferences_updated_at
    BEFORE UPDATE ON public.user_preferences
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.user_preferences
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- The row is the caller's own, or it does not exist to them. RESTRICTIVE, so
-- it ANDs with the policy above rather than offering an alternative way in.
CREATE POLICY require_own_row ON public.user_preferences
    AS RESTRICTIVE FOR ALL
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

-- ----------------------------------------------------------------------------
-- 2. What the restaurant looks like.
-- ----------------------------------------------------------------------------
CREATE TABLE public.organization_branding (
    organization_id uuid PRIMARY KEY REFERENCES public.organizations (id),

    -- A URL, not the bytes. The file lives in Supabase Storage so it survives
    -- the API being redeployed or moved — a logo written to the server's disk
    -- belongs to whichever machine happened to receive the upload, and vanishes
    -- with it.
    logo_url        text CHECK (logo_url IS NULL OR
                                (btrim(logo_url) <> '' AND char_length(logo_url) <= 2048)),

    -- What to print above a receipt. Falls back to the organization's name when
    -- unset; held separately because a legal name and a trading name are often
    -- not the same thing.
    display_name    text CHECK (display_name IS NULL OR
                                (btrim(display_name) <> '' AND char_length(display_name) <= 120)),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.organization_branding IS
    'The restaurant''s identity (0032): logo and trading name. Read by every member (a till prints it), written by administrators.';

CREATE TRIGGER trg_organization_branding_updated_at
    BEFORE UPDATE ON public.organization_branding
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.organization_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.organization_branding
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Everyone reads it — a receipt carries the logo, so a cashier's till needs it.
-- Only administrators change it, including DELETE: user_belongs_to_org is FOR
-- ALL and PERMISSIVE, so the grant alone would let any member remove the row
-- (the trap from 0014, 0019, 0024 and 0031).
CREATE POLICY require_admin_insert ON public.organization_branding
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.organization_branding
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_delete ON public.organization_branding
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

-- ----------------------------------------------------------------------------
-- 3. Privileges, per convention.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_preferences TO mosaiz_app_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_branding TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
