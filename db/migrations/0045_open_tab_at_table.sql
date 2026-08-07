-- ============================================================================
-- 0045_open_tab_at_table.sql — the till learns which table it is serving
--
-- 0043 gave orders a real `table_id`: a composite foreign key that cannot
-- point at another restaurant's table, and a partial unique index that allows
-- exactly one open tab per table. Since then the ONLY thing that has ever set
-- that column is app.seat_reservation — the admin screen, seating a booking.
--
-- Which leaves the actual floor out. A waiter opening a tab on the till writes
-- the table into `note`, as free text, because that is all 0029 ever had. So:
--
--   * "طاولة ٥" and "طاولة 5" and "T5" are three different tables to the
--     database and one table to the restaurant;
--   * nothing stops two tabs being opened on one table, because the index that
--     would have stopped it only bites when table_id is set;
--   * a booking seated in the admin and a tab opened at the till are two
--     unrelated records of one party sitting down, so the service report's
--     "bookings that became money" only ever counts half of them.
--
-- This teaches app.open_order about tables. Everything else about it holds:
-- the tab may still be EMPTY (a table is seated and given menus before it
-- orders anything), and it is still idempotent on client_offline_id, because
-- the till retries when the wifi drops and a retry must not seat the same
-- party twice.
--
-- ----------------------------------------------------------------------------
-- table_id IS OPTIONAL, AND STAYS OPTIONAL.
--
-- Not every order has a table. Takeaway and delivery do not, and a restaurant
-- that does not run the `reservations` module has no floor plan to choose
-- from at all — for them a tab is exactly what it was yesterday. A required
-- column here would have broken every one of those on the morning it shipped.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION app.open_order(payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org      uuid  := (payload ->> 'organization_id')::uuid;
    v_coid     uuid  := (payload ->> 'client_offline_id')::uuid;
    v_items    jsonb := payload -> 'items';
    v_note     text  := NULLIF(btrim(payload ->> 'note'), '');
    v_table    uuid  := NULLIF(btrim(payload ->> 'table_id'), '')::uuid;
    v_label    text;
    v_order_id uuid;
    v_missing  integer;
BEGIN
    IF v_org IS NULL OR v_coid IS NULL THEN
        RAISE EXCEPTION 'open_order requires organization_id and client_offline_id'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The tenant boundary, since DEFINER means RLS will not draw one.
    IF NOT app.user_belongs_to_org(v_org) THEN
        RAISE EXCEPTION 'organization % not found', v_org
            USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT app.user_can_sell(v_org) THEN
        RAISE EXCEPTION 'opening an order is limited to sales roles'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- ---- The table (0045) -------------------------------------------------
    IF v_table IS NOT NULL THEN
        -- Checked here as well as by 0043's composite foreign key, because the
        -- FK's answer is "23503 on orders_table_same_tenant", which tells a
        -- waiter nothing. Same reason the item check above exists.
        SELECT t.label INTO v_label
          FROM public.restaurant_tables t
         WHERE t.id = v_table
           AND t.organization_id = v_org;

        IF v_label IS NULL THEN
            RAISE EXCEPTION 'no such table in this restaurant'
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- One tab per table. 0043's partial unique index is the guarantee; this
        -- is the sentence. Note it EXCLUDES this client_offline_id: a retried
        -- "open the tab" finds its own tab sitting at the table and must be
        -- allowed through to the idempotent path below, not told the table is
        -- busy by itself.
        IF EXISTS (
            SELECT FROM public.orders o
             WHERE o.table_id = v_table
               AND o.status = 'open'
               AND o.client_offline_id IS DISTINCT FROM v_coid
        ) THEN
            RAISE EXCEPTION 'table % is already running a tab', v_label
                USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
    END IF;

    -- An empty tab is legitimate: a table is seated before it orders.
    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array' THEN
        SELECT count(*) FILTER (WHERE s.id IS NULL) INTO v_missing
        FROM jsonb_array_elements(v_items) AS item
        LEFT JOIN public.sellable_items s
          ON s.id = (item ->> 'sellable_item_id')::uuid
         AND s.organization_id = v_org;
        IF v_missing > 0 THEN
            RAISE EXCEPTION 'order references % item(s) not on this menu', v_missing;
        END IF;
    END IF;

    BEGIN
        INSERT INTO public.orders
            (organization_id, client_offline_id, status, total_amount, served_by, note, table_id)
        VALUES (v_org, v_coid, 'open', 0,
                NULLIF(current_setting('app.current_user_id', true), '')::uuid, v_note, v_table)
        -- Idempotent like checkout: a retried "open the tab" must not open a second.
        ON CONFLICT (organization_id, client_offline_id) DO NOTHING
        RETURNING id INTO v_order_id;
    EXCEPTION
        -- The check above lost a race with another till. ON CONFLICT does not
        -- cover this one — it names the client_offline_id constraint, and the
        -- index that fired here is orders_one_open_tab_per_table. Without this
        -- the waiter gets a 500 for two people seating one table at once,
        -- which is a Friday night, not a bug.
        WHEN unique_violation THEN
            RAISE EXCEPTION 'table % is already running a tab', COALESCE(v_label, '?')
                USING ERRCODE = 'object_not_in_prerequisite_state';
    END;

    IF v_order_id IS NULL THEN
        SELECT id INTO v_order_id FROM public.orders
        WHERE organization_id = v_org AND client_offline_id = v_coid;
        RETURN v_order_id;
    END IF;

    IF v_items IS NOT NULL AND jsonb_typeof(v_items) = 'array'
       AND jsonb_array_length(v_items) > 0 THEN
        PERFORM app.add_order_items(v_order_id, v_items);
    END IF;

    RETURN v_order_id;
END;
$$;

COMMENT ON FUNCTION app.open_order(jsonb) IS
    'Opens a tab, optionally AT a table (0029, 0045). Idempotent on client_offline_id. table_id is optional: takeaway has no table, and a restaurant that does not run the reservations module has no floor plan to pick from.';

COMMIT;
