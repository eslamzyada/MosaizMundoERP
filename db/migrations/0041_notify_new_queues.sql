-- ============================================================================
-- Migration 0041: Telling people about the queues we just built
-- Mosaiz Mundo ERP
--
-- 0036 exists because 0035 created a queue nobody was told about: a kitchen
-- proposal sat until somebody happened to open the menu page, which made a
-- careful two-person rule feel like a black hole.
--
-- Then 0038, 0039 and 0040 created three more queues with exactly that
-- problem. The worst is 0040's: a member of the public places an order and it
-- waits, unseen, until a member of staff thinks to look at a page. A proposal
-- going unnoticed is an annoyance. A CUSTOMER going unnoticed is a lost sale
-- and somebody standing in a doorway.
--
-- ----------------------------------------------------------------------------
-- THREE EVENTS, AND THE TEST FOR EACH IS THE SAME QUESTION:
-- can the person receiving it do something about it RIGHT NOW?
--
--   public order placed  -> yes. Somebody is waiting for an answer.
--   shift scheduled      -> yes, for the person on it. When you work is a
--                           thing you act on.
--   booking for TODAY    -> yes. A table is about to be needed.
--
-- And the ones NOT wired, for the same reason:
--
--   a booking three weeks out — nobody does anything with that today; the
--   book is read at service time, and a notification per booking would make
--   the bell into noise that people learn to dismiss. The 24-hour window is
--   the whole difference between a signal and a nag.
--   a rota published for next month — same argument, except for the person
--   ON it, which is why that one IS sent.
--
-- Every event here reuses 0036's app.notify_roles / app.notify_user. Nothing
-- new is granted, and the application role still cannot write a notification.
--
-- Depends on: 0036 (notifications), 0038 (shifts), 0039 (reservations),
--             0040 (public orders)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- A customer is waiting.
--
-- The trigger fires from inside app.place_public_order, which runs as the
-- owner on behalf of an ANONYMOUS caller. There is no actor: nobody who works
-- here did this, so actor_id stays null and 0036's not-self CHECK is satisfied
-- by every recipient.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.notify_public_order_placed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_items text;
BEGIN
    -- The lines are inserted AFTER this row, so there is nothing to summarise
    -- yet — the body names the customer and the total, which is what decides
    -- whether somebody walks over to the tablet.
    v_items := coalesce(NEW.customer_name, '') || ' — ' ||
               to_char(NEW.quoted_total, 'FM999999990.00') || ' ج.م';

    PERFORM app.notify_roles(
        NEW.organization_id,
        -- Everybody who is offered the queue in the sidebar. The cashier is
        -- not: their tool is the till, and 0034's whole point was that a
        -- cashier's screen is the POS.
        ARRAY['owner', 'regional_manager', 'branch_manager', 'waiter', 'kitchen'],
        'public_order_placed',
        'طلب جديد من الإنترنت',
        v_items,
        '/online-orders',
        NULL);

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_public_order_placed_notify
    AFTER INSERT ON public.public_orders
    FOR EACH ROW
    WHEN (NEW.status = 'pending')
    EXECUTE FUNCTION app.notify_public_order_placed();

-- ----------------------------------------------------------------------------
-- When you are working.
--
-- To the person ON the shift, not to the manager who wrote it — they already
-- know, they just typed it. 0036's notify_user returns 0 when the recipient is
-- the actor, so a manager scheduling themselves is silently not told, which is
-- the right answer rather than an error.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.notify_shift_scheduled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_when text;
BEGIN
    -- A time, in the tenant's own reading. Not an ISO timestamp: "2026-08-09
    -- 17:00:00+03" is not what anybody wants to read on a phone.
    v_when := to_char(NEW.starts_at, 'YYYY-MM-DD HH24:MI') || ' — ' ||
              to_char(NEW.ends_at, 'HH24:MI');

    PERFORM app.notify_user(
        NEW.organization_id,
        NEW.user_id,
        CASE WHEN TG_OP = 'INSERT' THEN 'shift_scheduled' ELSE 'shift_changed' END,
        CASE WHEN TG_OP = 'INSERT' THEN 'وردية جديدة في جدولك' ELSE 'تغيّرت إحدى ورديّاتك' END,
        v_when,
        '/schedule',
        NEW.created_by);

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_shift_scheduled_notify
    AFTER INSERT ON public.shifts
    FOR EACH ROW EXECUTE FUNCTION app.notify_shift_scheduled();

CREATE TRIGGER trg_shift_changed_notify
    AFTER UPDATE ON public.shifts
    FOR EACH ROW
    -- Only when the HOURS moved. Editing a note is not news.
    WHEN (OLD.starts_at IS DISTINCT FROM NEW.starts_at
       OR OLD.ends_at   IS DISTINCT FROM NEW.ends_at
       OR OLD.user_id   IS DISTINCT FROM NEW.user_id)
    EXECUTE FUNCTION app.notify_shift_scheduled();

-- ----------------------------------------------------------------------------
-- A table is needed today.
--
-- Same-day only. A booking for next month is not something anybody acts on
-- now, and one notification per booking would turn the bell into noise — at
-- which point the notifications that DO matter get dismissed with the rest.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.notify_reservation_today()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_label text;
BEGIN
    IF NEW.starts_at > now() + interval '24 hours' THEN
        RETURN NEW;
    END IF;

    SELECT t.label INTO v_label
      FROM public.restaurant_tables t WHERE t.id = NEW.table_id;

    PERFORM app.notify_roles(
        NEW.organization_id,
        ARRAY['owner', 'regional_manager', 'branch_manager', 'waiter'],
        'reservation_today',
        'حجز اليوم',
        NEW.guest_name || ' — ' || coalesce(v_label, '') || ' ' ||
            to_char(NEW.starts_at, 'HH24:MI') || ' — ' ||
            NEW.party_size || ' أشخاص',
        '/reservations',
        NEW.created_by);

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reservation_today_notify
    AFTER INSERT ON public.reservations
    FOR EACH ROW
    WHEN (NEW.status = 'booked')
    EXECUTE FUNCTION app.notify_reservation_today();

COMMENT ON FUNCTION app.notify_public_order_placed() IS
    'Tells the floor a customer is waiting (0041). Fires from inside app.place_public_order, which runs on behalf of an ANONYMOUS caller — so actor_id is null, because nobody who works here did this.';

COMMIT;
