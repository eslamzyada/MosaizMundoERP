-- ============================================================================
-- Migration 0043: Sitting the guest down
-- Mosaiz Mundo ERP
--
-- 0039 gave the restaurant a book: "table 7 at eight, Ahmed, four people".
-- 0029 gave it open tabs. Neither knows the other exists — `orders` has no
-- table reference at all — so when Ahmed walks in, the host marks the booking
-- and a waiter opens a tab, and nothing connects the two. The covers report
-- cannot say which bookings turned into money, and "is table 7 free" has two
-- different answers depending on which screen you ask.
--
-- ----------------------------------------------------------------------------
-- ONE OPEN TAB PER TABLE. That is the rule this migration exists to enforce.
--
-- Two open tabs on table 7 means somebody pays for the other party's drinks,
-- or the second tab is invisible and walks out unpaid. It is a partial unique
-- index rather than a check in the seating procedure, for the same reason
-- 0038's one-open-time-entry index is: two waiters seating the same table in
-- the same second is exactly the case a check-then-insert loses.
--
-- Partial, because most orders have no table at all — a till sale and a
-- takeaway are not sitting anywhere — and NULLs must not collide with each
-- other.
--
-- ----------------------------------------------------------------------------
-- SEATING IS ONE ACT, so it is one transaction: the booking becomes 'seated',
-- a tab opens at its table, and the two point at each other. Doing it in two
-- steps from the client leaves a booking marked seated with no tab, or a tab
-- with nobody responsible for it, every time a phone loses signal halfway.
--
-- Depends on: 0029 (open orders), 0037 (modules), 0039 (tables and bookings)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Where an order is being served.
--
-- NULLABLE, and it will stay mostly null: every existing order has no table,
-- and a till sale never will. This is not a defect to backfill.
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN table_id uuid;

ALTER TABLE public.orders
    ADD CONSTRAINT orders_table_same_tenant
    FOREIGN KEY (table_id, organization_id)
    REFERENCES public.restaurant_tables (id, organization_id);

COMMENT ON COLUMN public.orders.table_id IS
    'Where this order is being served (0043). Null for a till sale or a takeaway — most orders have no table, and that is not missing data.';

-- THE RULE. One open tab per table, enforced under concurrency.
CREATE UNIQUE INDEX orders_one_open_tab_per_table
    ON public.orders (table_id)
    WHERE status = 'open' AND table_id IS NOT NULL;

CREATE INDEX orders_table_idx
    ON public.orders (table_id, created_at DESC)
    WHERE table_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Which tab a booking became.
-- ----------------------------------------------------------------------------
ALTER TABLE public.reservations
    ADD COLUMN seated_order_id uuid;

ALTER TABLE public.reservations
    ADD CONSTRAINT reservations_order_same_tenant
    FOREIGN KEY (seated_order_id, organization_id)
    REFERENCES public.orders (id, organization_id);

COMMENT ON COLUMN public.reservations.seated_order_id IS
    'The tab this booking became (0043). Null until the guests are sat down — and the covers report reads it to answer which bookings actually turned into money.';

-- ----------------------------------------------------------------------------
-- Sitting them down.
--
-- SECURITY INVOKER, like 0040's acceptance and for the same reason: this opens
-- a real tab, so it must run as the person doing it, under their role and
-- their RLS. Nothing here is done on anybody's behalf.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.seat_reservation(
    p_reservation_id  uuid,
    p_client_offline_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    v_res   public.reservations;
    v_coid  uuid := COALESCE(p_client_offline_id, gen_random_uuid());
    v_order uuid;
BEGIN
    -- Read through RLS: a booking in another restaurant is not visible, so
    -- this finds nothing and says so.
    SELECT * INTO v_res FROM public.reservations WHERE id = p_reservation_id;

    IF v_res.id IS NULL THEN
        RAISE EXCEPTION 'no such booking' USING ERRCODE = 'no_data_found';
    END IF;

    -- Already sat down. Return the tab they are already on rather than opening
    -- a second one — a double tap on a phone must not cost the guest two bills.
    IF v_res.status = 'seated' AND v_res.seated_order_id IS NOT NULL THEN
        RETURN v_res.seated_order_id;
    END IF;

    IF v_res.status <> 'booked' THEN
        RAISE EXCEPTION 'that booking is %, not waiting to be seated', v_res.status
            USING ERRCODE = 'object_not_in_prerequisite_state';        -- 55000
    END IF;

    IF NOT app.org_has_module(v_res.organization_id, 'reservations') THEN
        RAISE EXCEPTION 'this restaurant does not run reservations'
            USING ERRCODE = 'feature_not_supported';                   -- 0A000
    END IF;

    -- The tab. Opened directly rather than through app.open_order, because
    -- that procedure takes items and a party being seated has not ordered
    -- anything yet — an empty tab is exactly right, and 0029 already allows it.
    INSERT INTO public.orders
        (organization_id, client_offline_id, status, total_amount, table_id,
         served_by, note)
    VALUES (v_res.organization_id, v_coid, 'open', 0, v_res.table_id,
            NULLIF(current_setting('app.current_user_id', true), '')::uuid,
            v_res.guest_name)
    RETURNING id INTO v_order;

    UPDATE public.reservations
       SET status = 'seated', seated_order_id = v_order
     WHERE id = p_reservation_id;

    RETURN v_order;
EXCEPTION
    -- The partial unique index. Its own sentence, because "that table already
    -- has a tab open" is a floor problem with a floor fix — settle the other
    -- one, or seat them elsewhere.
    WHEN unique_violation THEN
        RAISE EXCEPTION 'that table already has an open tab'
            USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

COMMENT ON FUNCTION app.seat_reservation(uuid, uuid) IS
    'Seats a booking and opens its tab in ONE transaction (0043). Two steps from a client leaves a booking marked seated with no tab every time a phone loses signal halfway. SECURITY INVOKER: it opens a real order, so it runs as whoever did it.';

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.seat_reservation(uuid, uuid) TO mosaiz_app_user;
        -- The new column, so a waiter can move a tab between tables.
        GRANT UPDATE (table_id) ON public.orders TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Settling the tab finishes the booking.
--
-- Otherwise every seated booking stays 'seated' forever and the book fills
-- with parties who left hours ago. Nobody should have to remember to close
-- something the till already closed.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.complete_reservation_on_settle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.status = 'open' AND NEW.status <> 'open' THEN
        UPDATE public.reservations
           SET status = CASE WHEN NEW.status = 'voided' THEN 'cancelled' ELSE 'completed' END
         WHERE seated_order_id = NEW.id
           AND status = 'seated';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_complete_reservation_on_settle
    AFTER UPDATE ON public.orders
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION app.complete_reservation_on_settle();

COMMIT;
