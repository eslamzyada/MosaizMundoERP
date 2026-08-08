-- ============================================================================
-- 0047_till_sessions.sql — does the drawer balance?
--
-- 0046 recorded HOW each bill was paid. This is what that was for: at the end
-- of a service somebody counts the cash in the drawer and compares it to what
-- the system says should be there. The difference is the single most useful
-- number a restaurant produces about itself daily, and until now the system
-- could not produce it.
--
--     expected = opening float + cash tendered while this session was open
--     variance = counted − expected
--
-- ----------------------------------------------------------------------------
-- WHY PAYMENTS ARE LINKED TO A SESSION, NOT MATCHED BY TIME.
--
-- The obvious implementation sums cash payments between opened_at and
-- closed_at. It is wrong twice. A payment taken in the same second as the
-- close lands on one side or the other depending on clock skew, and a
-- restaurant running two tills at once cannot attribute anything at all —
-- both windows overlap and both claim all the money.
--
-- So `order_payments.till_session_id` is stamped when the money is recorded,
-- by the same function that records it. The session owns the payment; nothing
-- is inferred afterwards.
--
-- ----------------------------------------------------------------------------
-- AND WHY A NULL SESSION IS ALLOWED.
--
-- Money taken while no session is open belongs to no cash-up. That happens:
-- somebody sells before opening the till, or a session was closed early. The
-- honest record is NULL — the same choice 0046 made for a sale with no tender.
--
-- Refusing the sale instead would put the till between a customer and their
-- food over a bookkeeping detail, and defaulting it into whichever session
-- comes next would move money into a shift it was not taken in, which is
-- precisely the accusation a cash-up exists to avoid making.
--
-- ----------------------------------------------------------------------------
-- ONE OPEN SESSION PER RESTAURANT, for now.
--
-- Not per device. A per-till model needs the device to carry a session id
-- through every request, and this system has no device identity yet. One
-- drawer per restaurant is what a single-till café actually has, and the
-- partial unique index below means the second one is refused rather than
-- silently splitting the night's cash in half.
-- ============================================================================

BEGIN;

CREATE TABLE public.till_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    opened_at       timestamptz NOT NULL DEFAULT now(),
    opened_by       uuid REFERENCES public.users (id) ON DELETE SET NULL,
    -- What was in the drawer before trading. Zero is a legitimate float.
    opening_float   numeric(12, 2) NOT NULL DEFAULT 0,

    closed_at       timestamptz,
    closed_by       uuid REFERENCES public.users (id) ON DELETE SET NULL,

    -- All three are NULL until the close, and FROZEN at it. `expected` is
    -- stored rather than recomputed on read for the same reason cost_at_sale
    -- is: a number somebody signed off on must not move afterwards, and a
    -- later correction to an old payment would silently rewrite a variance a
    -- cashier was once held to.
    counted_cash    numeric(12, 2),
    expected_cash   numeric(12, 2),
    variance        numeric(12, 2),

    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT till_sessions_float_check CHECK (opening_float >= 0),
    CONSTRAINT till_sessions_counted_check
        CHECK (counted_cash IS NULL OR counted_cash >= 0),

    -- Closed means ALL of it, or none. A row with a close time and no count is
    -- a cash-up nobody did, wearing the shape of one that was done.
    CONSTRAINT till_sessions_closed_together CHECK (
        (closed_at IS NULL AND counted_cash IS NULL
             AND expected_cash IS NULL AND variance IS NULL)
        OR
        (closed_at IS NOT NULL AND counted_cash IS NOT NULL
             AND expected_cash IS NOT NULL AND variance IS NOT NULL)
    ),

    CONSTRAINT till_sessions_note_check
        CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 500))
);

-- One drawer open at a time. Partial, so closed sessions stack up freely —
-- the same shape as one open tab per table (0043) and one open time entry per
-- person (0038).
CREATE UNIQUE INDEX till_sessions_one_open_per_org
    ON public.till_sessions (organization_id) WHERE closed_at IS NULL;

CREATE INDEX till_sessions_org_opened_idx
    ON public.till_sessions (organization_id, opened_at DESC);

COMMENT ON TABLE public.till_sessions IS
    'A drawer, from opening float to counted close (0047). variance = counted − expected, frozen at close so a number somebody was held to cannot move afterwards.';

COMMENT ON COLUMN public.till_sessions.expected_cash IS
    'Opening float plus the CASH tendered against this session. Stored, not recomputed: a later correction to an old payment must not rewrite a variance that has already been signed off.';

ALTER TABLE public.till_sessions ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_till_sessions_updated_at
    BEFORE UPDATE ON public.till_sessions
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Readable by the restaurant. No write policy: opening and closing go through
-- the two procedures below, so a variance cannot be edited into agreement.
CREATE POLICY user_belongs_to_org ON public.till_sessions
    FOR SELECT USING (app.user_belongs_to_org(organization_id));

-- ----------------------------------------------------------------------------
-- The link. Stamped when the money is recorded, never inferred later.
-- ----------------------------------------------------------------------------

ALTER TABLE public.order_payments
    ADD COLUMN till_session_id uuid REFERENCES public.till_sessions (id) ON DELETE SET NULL;

CREATE INDEX order_payments_session_idx
    ON public.order_payments (till_session_id) WHERE till_session_id IS NOT NULL;

COMMENT ON COLUMN public.order_payments.till_session_id IS
    'The drawer that was open when this money was taken (0047). NULL means none was — honest, and not the same as belonging to the next one.';

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT ON public.till_sessions TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- record_payments learns to stamp the session.
--
-- Redefined whole rather than patched, because it is the only writer of money
-- in the system and a reader should see all of it in one place. Everything
-- except the session lookup and the INSERT column is 0046's, verbatim.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.record_payments(
    p_order_id uuid,
    p_payments jsonb,
    p_total    numeric
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org     uuid;
    v_sum     numeric;
    v_count   integer;
    v_bad     text;
    v_session uuid;
BEGIN
    IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array'
       OR jsonb_array_length(p_payments) = 0 THEN
        RETURN 0;
    END IF;

    v_org := app.assert_may_serve_order(p_order_id);

    IF EXISTS (SELECT FROM public.order_payments WHERE order_id = p_order_id) THEN
        RAISE EXCEPTION 'this bill has already been paid'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT p ->> 'method' INTO v_bad
      FROM jsonb_array_elements(p_payments) AS p
     WHERE COALESCE(p ->> 'method', '') NOT IN
           ('cash', 'card', 'transfer', 'voucher', 'other')
     LIMIT 1;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'unknown payment method: %', COALESCE(v_bad, '(none)')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT ROUND(SUM((p ->> 'amount')::numeric), 2), count(*)
      INTO v_sum, v_count
      FROM jsonb_array_elements(p_payments) AS p;

    IF v_sum IS DISTINCT FROM ROUND(p_total, 2) THEN
        RAISE EXCEPTION 'payments total % but the bill is %', v_sum, ROUND(p_total, 2)
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The drawer that is open right now, if any. NOT an error when there is
    -- none: a till must never stand between a customer and their food over a
    -- bookkeeping detail. The money is simply recorded as belonging to no
    -- cash-up, which is what actually happened.
    SELECT s.id INTO v_session
      FROM public.till_sessions s
     WHERE s.organization_id = v_org
       AND s.closed_at IS NULL;

    INSERT INTO public.order_payments
        (organization_id, order_id, method, amount, received_by, note, till_session_id)
    SELECT v_org,
           p_order_id,
           p ->> 'method',
           ROUND((p ->> 'amount')::numeric, 2),
           NULLIF(current_setting('app.current_user_id', true), '')::uuid,
           NULLIF(btrim(p ->> 'note'), ''),
           v_session
      FROM jsonb_array_elements(p_payments) AS p;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION app.record_payments(uuid, jsonb, numeric) IS
    'Writes the tender for a completed order (0046) and stamps the drawer it belongs to (0047). Shared by app.settle_order and app.process_pos_checkout so the rules cannot drift. An empty list means UNSPECIFIED; no open session means the money belongs to no cash-up.';

-- ----------------------------------------------------------------------------
-- Opening the drawer.
-- ----------------------------------------------------------------------------

CREATE FUNCTION app.open_till_session(
    p_organization_id uuid,
    p_opening_float   numeric DEFAULT 0,
    p_note            text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_id    uuid;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'no identity bound' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT app.user_belongs_to_org(p_organization_id) THEN
        RAISE EXCEPTION 'organization % not found', p_organization_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- Whoever may take money may open the drawer they take it into. A separate
    -- role gate here would mean a cashier could ring up sales that belong to
    -- no cash-up, which is the failure this migration exists to remove.
    IF NOT app.user_can_sell(p_organization_id) THEN
        RAISE EXCEPTION 'opening the till is limited to sales roles'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_opening_float < 0 THEN
        RAISE EXCEPTION 'an opening float cannot be negative'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    BEGIN
        INSERT INTO public.till_sessions
            (organization_id, opened_by, opening_float, note)
        VALUES (p_organization_id, v_actor, ROUND(p_opening_float, 2),
                NULLIF(btrim(p_note), ''))
        RETURNING id INTO v_id;
    EXCEPTION
        -- The partial unique index. Said in words, because "duplicate key
        -- value violates unique constraint till_sessions_one_open_per_org" is
        -- not something to show somebody holding a float.
        WHEN unique_violation THEN
            RAISE EXCEPTION 'the till is already open; close it before opening another'
                USING ERRCODE = 'object_not_in_prerequisite_state';
    END;

    RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION app.open_till_session(uuid, numeric, text) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- Closing it, and the number that comes out.
-- ----------------------------------------------------------------------------

CREATE FUNCTION app.close_till_session(
    p_organization_id uuid,
    p_counted_cash    numeric,
    p_note            text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor    uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_id       uuid;
    v_float    numeric;
    v_cash     numeric;
    v_expected numeric;
    v_variance numeric;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'no identity bound' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT app.user_belongs_to_org(p_organization_id) THEN
        RAISE EXCEPTION 'organization % not found', p_organization_id
            USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT app.user_can_sell(p_organization_id) THEN
        RAISE EXCEPTION 'closing the till is limited to sales roles'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_counted_cash IS NULL OR p_counted_cash < 0 THEN
        RAISE EXCEPTION 'the counted cash must be a number, and not a negative one'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT s.id, s.opening_float INTO v_id, v_float
      FROM public.till_sessions s
     WHERE s.organization_id = p_organization_id
       AND s.closed_at IS NULL
       FOR UPDATE;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'the till is not open'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- ONLY CASH. A card payment never enters the drawer, so counting it here
    -- would produce a shortfall equal to the day's card takings and send
    -- somebody looking for money that was never in the room.
    --
    -- Voided sales are excluded for the same reason revenue excludes them:
    -- the money went back.
    SELECT COALESCE(SUM(p.amount), 0) INTO v_cash
      FROM public.order_payments p
      JOIN public.orders o ON o.id = p.order_id
     WHERE p.till_session_id = v_id
       AND p.method = 'cash'
       AND o.status <> 'voided';

    v_expected := ROUND(v_float + v_cash, 2);
    v_variance := ROUND(p_counted_cash, 2) - v_expected;

    UPDATE public.till_sessions
       SET closed_at     = now(),
           closed_by     = v_actor,
           counted_cash  = ROUND(p_counted_cash, 2),
           expected_cash = v_expected,
           variance      = v_variance,
           note          = COALESCE(NULLIF(btrim(p_note), ''), note)
     WHERE id = v_id;

    -- Somebody who is not the person counting needs to know, and needs to know
    -- WITHOUT having to go and look. A drawer that is short is the earliest
    -- signal a restaurant gets about several different problems.
    IF v_variance <> 0 THEN
        PERFORM app.notify_roles(
            p_organization_id,
            ARRAY['owner', 'regional_manager'],
            'till_variance',
            CASE WHEN v_variance < 0
                 THEN 'عجز في الدرج: ' || abs(v_variance)::text
                 ELSE 'زيادة في الدرج: ' || v_variance::text END,
            'المتوقع ' || v_expected::text || ' والمعدود ' || ROUND(p_counted_cash, 2)::text,
            '/reports',
            v_actor);
    END IF;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION app.close_till_session(uuid, numeric, text) IS
    'Counts the drawer and freezes the variance (0047). Only CASH counts toward expected — a card payment never entered the drawer, and including it would invent a shortfall the size of the day''s card takings.';

REVOKE EXECUTE ON FUNCTION app.close_till_session(uuid, numeric, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.open_till_session(uuid, numeric, text) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.close_till_session(uuid, numeric, text) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
