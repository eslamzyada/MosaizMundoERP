-- ============================================================================
-- 0046_payments.sql — how the bill was actually paid
--
-- Forty-five migrations in, an order records what it SOLD and what that cost,
-- and nothing whatsoever about the money that came back. `total_amount` and
-- then silence. Which means the system can tell a restaurant what it earned
-- and cannot tell it whether the drawer balances at close — the one thing a
-- restaurant checks every single night, and the check that catches both theft
-- and honest mistakes.
--
-- ----------------------------------------------------------------------------
-- THE RULE THIS WHOLE MIGRATION EXISTS FOR:
--
--     UNSPECIFIED IS NOT CASH.
--
-- Every order settled before today has no payment rows, and every till that
-- has not been updated will keep settling without them. The tempting move is
-- to default the method to 'cash' — it is what most of them were, the column
-- is then NOT NULL, and every report has a tidy number in it.
--
-- It would also be a lie of exactly the shape this codebase keeps refusing:
-- a gap you can see is survivable, a gap that reads as a number is not. A
-- cash-up variance computed against invented cash sales is worse than no
-- cash-up at all, because somebody would act on it — and what they would do
-- is accuse a cashier of being short.
--
-- So an order with no payment rows is UNSPECIFIED, it stays unspecified, and
-- every reader has to say so out loud. Same distinction as cost_is_complete,
-- as `labour: null` for a reader who may not see pay, and as `tables: null`
-- for a restaurant with no floor plan.
--
-- ----------------------------------------------------------------------------
-- WHY THE ROWS ARE A LIST AND NOT A COLUMN ON `orders`.
--
-- Split payment is ordinary: two friends, one card each; a card that declines
-- for the balance and cash for the rest. A single `payment_method` column
-- forces a lie the first time anybody does it, and the workaround is always
-- to record the larger half and lose the other.
-- ============================================================================

BEGIN;

CREATE TABLE public.order_payments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    -- Composite, so a payment cannot be attached to another tenant's order.
    -- Same shape 0043 used for orders.table_id.
    order_id        uuid NOT NULL,
    method          text NOT NULL,
    amount          numeric(12, 2) NOT NULL,
    -- Who took the money. NULL when the procedure ran without a bound
    -- identity, which is rare and honest — inventing a cashier on a money
    -- record would be worse than admitting nobody was recorded.
    received_by     uuid REFERENCES public.users (id) ON DELETE SET NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT order_payments_order_same_tenant
        FOREIGN KEY (order_id, organization_id)
        REFERENCES public.orders (id, organization_id) ON DELETE CASCADE,

    -- A fixed vocabulary, deliberately. Per-tenant payment methods would be a
    -- third configurability mechanism, and the design note for 0037 says to
    -- resist exactly that: what varies between restaurants is which
    -- CAPABILITIES they run, not the words inside one. 'other' carries the
    -- long tail, with `note` for what it actually was.
    CONSTRAINT order_payments_method_check
        CHECK (method IN ('cash', 'card', 'transfer', 'voucher', 'other')),

    -- Zero is not a payment, and a negative one is a refund — which this
    -- system does not have yet, and must not acquire by accident through a
    -- minus sign in a till payload.
    CONSTRAINT order_payments_amount_check CHECK (amount > 0),

    CONSTRAINT order_payments_note_check
        CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 200))
);

CREATE INDEX order_payments_order_idx ON public.order_payments (order_id);
CREATE INDEX order_payments_org_created_idx
    ON public.order_payments (organization_id, created_at DESC);

COMMENT ON TABLE public.order_payments IS
    'How a bill was paid (0046). A LIST, because splitting a bill is ordinary. An order with no rows here is UNSPECIFIED, which is not the same as cash and must never be reported as it.';

COMMENT ON COLUMN public.order_payments.amount IS
    'What this tender contributed to the bill — not what was handed over. Cash given for a smaller bill produces change, and the change never entered the business.';

ALTER TABLE public.order_payments ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_order_payments_updated_at
    BEFORE UPDATE ON public.order_payments
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Readable by the restaurant it happened in. NO insert, update or delete
-- policy: money records are written by the two procedures that complete an
-- order and by nothing else, so a till cannot invent a payment for a bill it
-- did not settle. Deny-by-default, as the identity-adjacent tables do.
CREATE POLICY user_belongs_to_org ON public.order_payments
    FOR SELECT USING (app.user_belongs_to_org(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT ON public.order_payments TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Recording the tender. One helper, used by both paths that complete an order,
-- so the rules cannot drift between the tab and the counter sale.
-- ----------------------------------------------------------------------------

CREATE FUNCTION app.record_payments(
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
    v_org   uuid;
    v_sum   numeric;
    v_count integer;
    v_bad   text;
BEGIN
    -- No payments given is ALLOWED, and means unspecified. A till that has not
    -- been updated must keep working; what it must not do is have a method
    -- guessed for it.
    IF p_payments IS NULL OR jsonb_typeof(p_payments) <> 'array'
       OR jsonb_array_length(p_payments) = 0 THEN
        RETURN 0;
    END IF;

    -- SELF-DEFENDING, because this has to be callable by the app role.
    --
    -- process_pos_checkout is SECURITY INVOKER on purpose (0004): it runs as
    -- the cashier who rang the sale up, so the sale is attributed to a real
    -- person. That means it cannot call a function the app role may not
    -- execute — and granting EXECUTE on a DEFINER function that writes money
    -- without checking anything would let a till record a payment against any
    -- order id it could name, in its own tenant or otherwise.
    --
    -- So the same gate the till already passes to serve an order: right
    -- tenant, right role. It answers "not found" for another restaurant's
    -- order rather than "forbidden", so an id cannot be probed across tenants.
    v_org := app.assert_may_serve_order(p_order_id);

    -- Once. A second call would stack a second set of tenders onto a bill that
    -- is already paid for, and the sum check below would pass each time —
    -- doubling the night's takings one retry at a time.
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

    -- The payments must add up to the bill. Without this the whole table is
    -- decoration: a cash-up reconciles counted money against recorded money,
    -- and recorded money that does not match the bill reconciles nothing.
    IF v_sum IS DISTINCT FROM ROUND(p_total, 2) THEN
        RAISE EXCEPTION 'payments total % but the bill is %', v_sum, ROUND(p_total, 2)
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.order_payments
        (organization_id, order_id, method, amount, received_by, note)
    SELECT v_org,
           p_order_id,
           p ->> 'method',
           ROUND((p ->> 'amount')::numeric, 2),
           NULLIF(current_setting('app.current_user_id', true), '')::uuid,
           NULLIF(btrim(p ->> 'note'), '')
      FROM jsonb_array_elements(p_payments) AS p;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION app.record_payments(uuid, jsonb, numeric) IS
    'Writes the tender for a completed order (0046). Shared by app.settle_order and app.process_pos_checkout so the rules cannot drift between a tab and a counter sale. An empty list is allowed and means UNSPECIFIED.';

REVOKE EXECUTE ON FUNCTION app.record_payments(uuid, jsonb, numeric) FROM PUBLIC;

-- Granted, because process_pos_checkout runs as the CALLER and could not
-- otherwise reach it. Safe to grant only because of the two guards above: the
-- caller must be entitled to serve that order, and a bill can only be paid
-- once.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.record_payments(uuid, jsonb, numeric) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Settling a tab, now with the tender.
--
-- The second argument DEFAULTS to NULL, so every existing caller keeps
-- compiling and keeps working — it simply records an unspecified sale, which
-- is exactly what it has been doing since 0029.
-- ----------------------------------------------------------------------------

-- DROPPED, not replaced. CREATE OR REPLACE cannot change a signature — it
-- creates a second function — and `settle_order(uuid)` would then match BOTH
-- the old one-argument version and this one's default, which PostgreSQL
-- refuses as "function is not unique". Every existing caller passes one
-- argument, so leaving the old definition in place breaks all of them.
DROP FUNCTION IF EXISTS app.settle_order(uuid);

CREATE FUNCTION app.settle_order(
    p_order_id uuid,
    p_payments jsonb DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_status  text;
    v_pending integer;
    v_total   numeric;
BEGIN
    PERFORM app.assert_may_serve_order(p_order_id);

    SELECT status INTO v_status FROM public.orders WHERE id = p_order_id;
    IF v_status <> 'open' THEN
        RAISE EXCEPTION 'order % is % and cannot be settled', p_order_id, v_status
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT count(*) INTO v_pending
    FROM public.order_items WHERE order_id = p_order_id AND fired_at IS NULL;
    IF v_pending > 0 THEN
        RAISE EXCEPTION
            '% item(s) have not been sent to the kitchen; send or remove them '
            'before settling', v_pending
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = p_order_id) THEN
        RAISE EXCEPTION 'an empty order cannot be settled'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    v_total := app.recalculate_order_total(p_order_id);

    -- Before the status changes, though NOT because the ordering is what makes
    -- this safe: the whole settle is one statement, so a tender that does not
    -- add up rolls the status back with it whichever order these two run in.
    -- (Verified by injection — swapping them changes nothing.) It is first
    -- because failing before doing the work is cheaper, and because reading it
    -- in this order matches what happens at a till: you take the money, then
    -- you close the bill.
    PERFORM app.record_payments(p_order_id, p_payments, v_total);

    UPDATE public.orders SET status = 'completed' WHERE id = p_order_id;
    RETURN v_total;
END;
$$;

COMMENT ON FUNCTION app.settle_order(uuid, jsonb) IS
    'Closes a tab (0029) and records how it was paid (0046). The payments are optional and their absence means UNSPECIFIED, never cash.';

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.settle_order(uuid, jsonb) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The counter sale.
--
-- Half the money in a quick-service restaurant never touches a tab, so leaving
-- this path out would leave half the night unattributed — and a payment mix
-- computed from the other half would be confidently wrong rather than visibly
-- incomplete.
--
-- Only the tail of the procedure changes; everything above it is 0012's, kept
-- verbatim so this migration is a diff a reviewer can actually read.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE PROCEDURE app.process_pos_checkout(IN payload jsonb)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org_id   uuid  := (payload ->> 'organization_id')::uuid;
    v_coid     uuid  := (payload ->> 'client_offline_id')::uuid;
    v_items    jsonb := payload -> 'items';
    v_payments jsonb := payload -> 'payments';
    v_total    numeric;
    v_missing  integer;
    v_order_id uuid;
    v_ded      record;
    v_costs    jsonb := '{}'::jsonb;
    v_cost     numeric;
    v_short    numeric;
    v_served_by uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
    v_note      text := NULLIF(btrim(payload ->> 'note'), '');
BEGIN
    IF v_org_id IS NULL OR v_coid IS NULL THEN
        RAISE EXCEPTION
            'checkout payload must include organization_id and client_offline_id';
    END IF;
    IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array'
       OR jsonb_array_length(v_items) = 0 THEN
        RAISE EXCEPTION 'checkout payload must include a non-empty items array';
    END IF;

    SELECT count(*) FILTER (WHERE s.id IS NULL)
      INTO v_missing
    FROM jsonb_array_elements(v_items) AS item
    LEFT JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org_id;

    IF v_missing > 0 THEN
        RAISE EXCEPTION
            'checkout references % item(s) not available in this organization', v_missing;
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_items) AS item
        WHERE COALESCE((item ->> 'quantity')::integer, 0) <= 0
    ) THEN
        RAISE EXCEPTION 'every checkout line must have a positive quantity';
    END IF;

    SELECT sum(s.price * (item ->> 'quantity')::integer)
      INTO v_total
    FROM jsonb_array_elements(v_items) AS item
    JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org_id;

    INSERT INTO public.orders
        (organization_id, client_offline_id, total_amount, served_by, note)
    VALUES (v_org_id, v_coid, v_total, v_served_by, v_note)
    ON CONFLICT (organization_id, client_offline_id) DO NOTHING
    RETURNING id INTO v_order_id;

    -- Retry of an already-processed checkout: silent no-op. No re-deduction, no
    -- double-counted cost, and no duplicate consumption rows.
    --
    -- And, since 0046, no duplicate PAYMENT rows either. A till retrying a
    -- checkout whose answer it never saw would otherwise record the money
    -- twice, which is the one kind of duplicate nobody notices until the
    -- drawer is short at the end of the night.
    IF v_order_id IS NULL THEN
        RETURN;
    END IF;

    PERFORM app.record_payments(v_order_id, v_payments, v_total);

    FOR v_ded IN
        SELECT bom.raw_item_id,
               SUM(bom.quantity_required * (item ->> 'quantity')::integer) AS total_qty
        FROM jsonb_array_elements(v_items) AS item
        JOIN public.bill_of_materials bom
          ON bom.sellable_item_id = (item ->> 'sellable_item_id')::uuid
         AND bom.organization_id  = v_org_id
        GROUP BY bom.raw_item_id
        ORDER BY bom.raw_item_id
    LOOP
        v_cost  := 0;
        v_short := 0;

        CALL app.process_inventory_deduction_costed(
            v_ded.raw_item_id, v_org_id, v_ded.total_qty, v_cost, v_short, v_order_id);

        v_costs := v_costs || jsonb_build_object(
            v_ded.raw_item_id::text,
            jsonb_build_object('cost', v_cost, 'short', v_short, 'qty', v_ded.total_qty));
    END LOOP;

    INSERT INTO public.order_items
        (order_id, organization_id, sellable_item_id, quantity, unit_price,
         cost_at_sale, cost_is_complete, note, fired_at)
    SELECT
        v_order_id,
        v_org_id,
        (item ->> 'sellable_item_id')::uuid,
        (item ->> 'quantity')::integer,
        s.price,
        COALESCE(c.line_cost, 0),
        COALESCE(c.complete, false),
        NULLIF(btrim(item ->> 'note'), ''),
        -- A counter sale is fired the instant it is rung up: the kitchen is
        -- told and the stock has already moved by the time this row exists.
        now()
    FROM jsonb_array_elements(v_items) AS item
    JOIN public.sellable_items s
      ON s.id = (item ->> 'sellable_item_id')::uuid
     AND s.organization_id = v_org_id
    LEFT JOIN LATERAL (
        SELECT
            SUM(
                (v_costs -> bom.raw_item_id::text ->> 'cost')::numeric
                * (bom.quantity_required * (item ->> 'quantity')::integer)
                / NULLIF((v_costs -> bom.raw_item_id::text ->> 'qty')::numeric, 0)
            ) AS line_cost,
            BOOL_AND(
                COALESCE((v_costs -> bom.raw_item_id::text ->> 'short')::numeric, 0) = 0
            ) AS complete
        FROM public.bill_of_materials bom
        WHERE bom.sellable_item_id = (item ->> 'sellable_item_id')::uuid
          AND bom.organization_id  = v_org_id
    ) c ON true;
END;
$$;

COMMENT ON PROCEDURE app.process_pos_checkout(jsonb) IS
    'A counter sale: order, costed stock deduction, lines, and how it was paid (0004/0006/0007/0012/0046). Idempotent on client_offline_id — including the payments, which a retry must not record twice.';

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON PROCEDURE app.process_pos_checkout(jsonb) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
