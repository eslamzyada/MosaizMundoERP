-- ============================================================================
-- Migration 0036: Telling people things happened
-- Mosaiz Mundo ERP
--
-- 0035 gave the menu an approval cycle and, in doing so, created a queue that
-- nobody is told about. A kitchen proposal sits until somebody happens to open
-- the menu page — which makes a careful two-person rule feel like a black hole.
-- That is the immediate need; the shape below is meant to serve the rest.
--
-- ----------------------------------------------------------------------------
-- A NOTIFICATION IS A COPY OF INFORMATION, DELIVERED OUTSIDE THE QUERY PATH.
--
-- That is the whole security problem. Every read in this system is filtered by
-- RLS, so what somebody may see is decided at the moment they ask. A
-- notification is decided at the moment something HAPPENS, by whoever caused
-- it, and then delivered later — so it can carry a fact past a policy that
-- would have refused it.
--
-- Two rules follow, and they are enforced rather than documented:
--
--   1. You read your OWN notifications and nobody else's. A RESTRICTIVE policy
--      covering SELECT, exactly like 0032's user_preferences.
--
--   2. The application role CANNOT INSERT. Not gated — not granted at all.
--      Every notification is written by a SECURITY DEFINER function that
--      decides the recipients itself from their ROLE. A client that can address
--      a notification to somebody is a client that can phish them, and no
--      amount of validation in a controller fixes that.
--
-- The one privilege the app role does get is UPDATE on read_at, and only that
-- column — a column-level grant, so "mark as read" cannot rewrite the message
-- it is acknowledging.
--
-- ----------------------------------------------------------------------------
-- WHAT GOES IN THE BODY.
--
-- Nothing the recipient could not already read. The two events wired here name
-- a dish and a person; they do not carry a margin, a cost, or a rating. That is
-- a rule for whoever adds the next event, and it is why notify_roles takes the
-- roles it is addressing — so the author has to think about who is reading.
--
-- Delivery is in the SAME TRANSACTION as the event. If the approval commits,
-- the notification commits; if it rolls back, nobody is told about a change
-- that did not happen. No queue, no worker, no second system to be down.
--
-- Depends on: 0011 (memberships), 0034 (waiter/kitchen), 0035 (menu cycle)
-- ============================================================================

BEGIN;

CREATE TABLE public.notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- Who is being told. NO ACTION: a notification that was sent stays sent.
    recipient_id    uuid NOT NULL REFERENCES public.users (id),
    -- Who caused it. Null for something the system noticed rather than someone
    -- doing it (a stock level crossing a threshold, say).
    actor_id        uuid REFERENCES public.users (id),

    -- A stable machine name, so a client can group or route without parsing
    -- Arabic prose. Deliberately not an enum: adding a kind should not need a
    -- migration, and an unknown kind renders as its subject either way.
    kind            text NOT NULL CHECK (char_length(btrim(kind)) BETWEEN 1 AND 60),

    subject         text NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 1 AND 160),
    body            text CHECK (body IS NULL OR char_length(body) <= 1000),

    -- Where to go. A relative path inside the admin, never a full URL: a
    -- notification that can carry an arbitrary link is a notification that can
    -- carry somebody off-site.
    link            text CHECK (link IS NULL OR (link LIKE '/%' AND char_length(link) <= 300)),

    read_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- Nobody is notified about their own action. Being told "you approved this"
    -- the instant you approve it is noise, and noise is what stops people
    -- reading the ones that matter.
    CONSTRAINT notifications_not_self CHECK (recipient_id IS DISTINCT FROM actor_id)
);

COMMENT ON TABLE public.notifications IS
    'One message for one person (0036). The application role cannot INSERT — every notification is written by a SECURITY DEFINER function that picks recipients by role — and can UPDATE only read_at.';

-- The unread badge is the hottest read in the system after the menu, so it gets
-- its own partial index rather than scanning a growing history.
CREATE INDEX notifications_unread_idx
    ON public.notifications (recipient_id, created_at DESC)
    WHERE read_at IS NULL;
CREATE INDEX notifications_inbox_idx
    ON public.notifications (recipient_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.notifications
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- FOR ALL, so it covers SELECT: your inbox is yours. Same decision as 0032's
-- preferences, for a stronger reason — a colleague's notifications describe
-- things they were told and you were not.
CREATE POLICY require_own_row ON public.notifications
    AS RESTRICTIVE FOR ALL
    USING      (recipient_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (recipient_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT ON public.notifications TO mosaiz_app_user;
        -- COLUMN-level, and only this column. "Mark as read" cannot rewrite the
        -- message it is acknowledging, and no INSERT is granted at all.
        GRANT UPDATE (read_at) ON public.notifications TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Delivery.
--
-- SECURITY DEFINER because the whole point is to write a row addressed to
-- somebody who is not the caller — which the own-row policy above forbids, on
-- purpose.
-- ----------------------------------------------------------------------------

/** Tells every ACTIVE member of [p_organization_id] holding one of [p_roles]. */
CREATE FUNCTION app.notify_roles(
    p_organization_id uuid,
    p_roles           text[],
    p_kind            text,
    p_subject         text,
    p_body            text DEFAULT NULL,
    p_link            text DEFAULT NULL,
    p_actor_id        uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_sent integer;
BEGIN
    INSERT INTO public.notifications
        (organization_id, recipient_id, actor_id, kind, subject, body, link)
    SELECT p_organization_id, m.user_id, p_actor_id, p_kind, p_subject, p_body, p_link
      FROM public.organization_memberships m
     WHERE m.organization_id = p_organization_id
       AND m.is_active
       AND m.role = ANY (p_roles)
       -- The actor is skipped rather than filtered out by the CHECK, so
       -- notifying a group that happens to include you is not an error.
       AND m.user_id IS DISTINCT FROM p_actor_id;

    GET DIAGNOSTICS v_sent = ROW_COUNT;
    RETURN v_sent;
END;
$$;

/** Tells one named person. Returns 0 when that is the actor themselves. */
CREATE FUNCTION app.notify_user(
    p_organization_id uuid,
    p_recipient_id    uuid,
    p_kind            text,
    p_subject         text,
    p_body            text DEFAULT NULL,
    p_link            text DEFAULT NULL,
    p_actor_id        uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_recipient_id IS NULL OR p_recipient_id IS NOT DISTINCT FROM p_actor_id THEN
        RETURN 0;
    END IF;

    -- Only a member. A notification to somebody who left, or to a person in
    -- another restaurant, is a delivery the RLS policies would never have made.
    IF NOT EXISTS (
        SELECT 1 FROM public.organization_memberships m
         WHERE m.organization_id = p_organization_id
           AND m.user_id = p_recipient_id
           AND m.is_active
    ) THEN
        RETURN 0;
    END IF;

    INSERT INTO public.notifications
        (organization_id, recipient_id, actor_id, kind, subject, body, link)
    VALUES (p_organization_id, p_recipient_id, p_actor_id, p_kind, p_subject, p_body, p_link);

    RETURN 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.notify_roles(uuid, text[], text, text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.notify_user(uuid, uuid, text, text, text, text, uuid) FROM PUBLIC;

-- Not granted to the application role either. These are called by triggers and
-- by other SECURITY DEFINER procedures — never from a controller, because a
-- controller that can send a notification can send any notification.

-- ----------------------------------------------------------------------------
-- The two events that need this today.
-- ----------------------------------------------------------------------------

/** A proposal arrives -> tell the people who can decide it. */
CREATE FUNCTION app.notify_menu_change_proposed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_what text;
BEGIN
    v_what := CASE NEW.kind
                WHEN 'create' THEN 'صنف جديد: ' || coalesce(NEW.proposed_name, '')
                WHEN 'retire' THEN 'إيقاف صنف عن القائمة'
                ELSE 'تعديل على صنف'
              END;

    PERFORM app.notify_roles(
        NEW.organization_id,
        ARRAY['owner', 'regional_manager'],
        'menu_change_proposed',
        'طلب تغيير في القائمة بانتظار قرارك',
        v_what || ' — ' || left(NEW.reason, 300),
        '/menu',
        NEW.requested_by);

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_menu_change_proposed_notify
    AFTER INSERT ON public.menu_change_requests
    FOR EACH ROW
    WHEN (NEW.status = 'pending')
    EXECUTE FUNCTION app.notify_menu_change_proposed();

/** A decision lands -> tell whoever asked. */
CREATE FUNCTION app.notify_menu_change_decided()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.status <> 'pending' OR NEW.status = 'pending' THEN
        RETURN NEW;
    END IF;
    -- Withdrawing is the proposer's own act; telling them about it is noise.
    IF NEW.status = 'withdrawn' THEN
        RETURN NEW;
    END IF;

    PERFORM app.notify_user(
        NEW.organization_id,
        NEW.requested_by,
        'menu_change_decided',
        CASE NEW.status
            WHEN 'approved' THEN 'تم اعتماد طلبك على القائمة'
            ELSE 'لم يُعتمد طلبك على القائمة'
        END,
        coalesce(left(NEW.decision_note, 300), NEW.reason),
        '/menu',
        NEW.decided_by);

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_menu_change_decided_notify
    AFTER UPDATE ON public.menu_change_requests
    FOR EACH ROW EXECUTE FUNCTION app.notify_menu_change_decided();

COMMENT ON FUNCTION app.notify_roles(uuid, text[], text, text, text, text, uuid) IS
    'Writes one notification per active member holding one of the given roles (0036). SECURITY DEFINER because addressing somebody else is exactly what the own-row policy forbids; not granted to the application role, because a caller that can send a notification can send any notification.';

COMMIT;
