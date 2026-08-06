-- ============================================================================
-- Migration 0040: Letting the public order, without letting the public in
-- Mosaiz Mundo ERP
--
-- Everything in this database is protected by one sentence: RLS binds
-- app.current_user_id, and a request with no identity sees nothing. Customer
-- ordering breaks that sentence, because a member of the public has no
-- identity and never will. This migration is the answer to "then how", and
-- almost all of it is refusal.
--
-- ----------------------------------------------------------------------------
-- THREE RULES, AND THEY ARE THE WHOLE DESIGN.
--
-- 1. THE TENANT COMES FROM THE SLUG, NEVER FROM THE REQUEST.
--    Every public function takes a storefront slug and derives
--    organization_id from it. No public entry point accepts an
--    organization_id, so there is no parameter to tamper with — a stranger
--    cannot address another restaurant's data because they cannot name it.
--
-- 2. THE PRICE COMES FROM THE MENU, NEVER FROM THE CUSTOMER.
--    Lines are priced by looking up sellable_items at the moment the order is
--    placed. The client sends item ids and quantities and nothing else. This
--    is the same rule 0012 established for the till, for the same reason, and
--    here the caller is anonymous so it matters more.
--
-- 3. A PUBLIC ORDER MOVES NOTHING.
--    It deducts no stock, captures no cost, and touches no figure a manager
--    reads. It is a REQUEST that lands in a queue. A member of staff accepts
--    it, and only then does the real checkout path run under a real identity.
--    An abusive script can therefore fill a queue — which is annoying and
--    reversible — but cannot empty an inventory or pollute a day's costs.
--
-- ----------------------------------------------------------------------------
-- WHAT IS HELD ABOUT A CUSTOMER: a name, a phone number, and what they asked
-- for. No account, no password, no address book, no order history across
-- visits. There is deliberately no customers table — every order stands alone,
-- so there is no profile to accumulate and nothing to breach beyond one
-- evening's tickets. Whoever adds the next column should have to argue with
-- this paragraph.
--
-- A customer follows their order with an unguessable token that lives in their
-- link. The token proves nothing about who they are and unlocks nothing but a
-- status word.
--
-- Depends on: 0008 (prices), 0012 (server-authoritative pricing), 0037 (modules)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- The shopfront.
-- ----------------------------------------------------------------------------
CREATE TABLE public.storefronts (
    organization_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- The only public name for a tenant. Lowercase, url-safe, and NOT the
    -- organization slug: this one is printed on menus and handed to the public,
    -- and a restaurant must be able to change it without renaming its account.
    slug            text NOT NULL UNIQUE
                    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),

    display_name    text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 80),
    greeting        text CHECK (greeting IS NULL OR char_length(greeting) <= 300),

    -- The switch a manager reaches for at 2am. Distinct from the module being
    -- enabled: the module is "we do this at all", this is "we are open now".
    is_accepting    boolean NOT NULL DEFAULT false,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.storefronts IS
    'A tenant''s public face (0040). The slug is the ONLY way the outside world can name a restaurant, and every public function derives organization_id from it — so no public entry point ever accepts a tenant id.';

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.storefronts
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.storefronts ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.storefronts
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

CREATE POLICY require_admin_insert ON public.storefronts
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));
CREATE POLICY require_admin_update ON public.storefronts
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_module_insert ON public.storefronts
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.org_has_module(organization_id, 'public_ordering'));
CREATE POLICY require_module_update ON public.storefronts
    AS RESTRICTIVE FOR UPDATE
    USING      (app.org_has_module(organization_id, 'public_ordering'))
    WITH CHECK (app.org_has_module(organization_id, 'public_ordering'));

-- ----------------------------------------------------------------------------
-- The queue.
-- ----------------------------------------------------------------------------
CREATE TABLE public.public_orders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    -- What the customer follows their order with. Random, unguessable, and
    -- separate from the id so that nothing derived from it can be enumerated.
    tracking_token  uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,

    customer_name   text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 2 AND 80),
    customer_phone  text NOT NULL CHECK (char_length(btrim(customer_phone)) BETWEEN 5 AND 20),
    note            text CHECK (note IS NULL OR char_length(note) <= 300),

    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'rejected', 'fulfilled', 'cancelled')),

    -- The total as QUOTED to the customer, computed here from the menu. Kept
    -- so that a later price change cannot rewrite what somebody was told.
    quoted_total    numeric(10, 2) NOT NULL CHECK (quoted_total >= 0),

    -- The real order, once a human accepted this request. Null until then, and
    -- that null is the whole safety property: no stock has moved.
    accepted_order_id uuid,
    decided_by      uuid REFERENCES public.users (id) ON DELETE SET NULL,
    decided_at      timestamptz,
    rejection_reason text CHECK (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) <= 300),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT public_orders_decision_is_attributable CHECK (
        (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
        OR (status <> 'pending' AND decided_at IS NOT NULL)
    ),
    -- An accepted request must point at the order it became. Anything else
    -- means stock moved with nothing to show for it, or the reverse.
    CONSTRAINT public_orders_accepted_has_order CHECK (
        (status = 'accepted' AND accepted_order_id IS NOT NULL)
        OR (status <> 'accepted' AND (accepted_order_id IS NOT NULL OR status <> 'fulfilled'))
    ),

    CONSTRAINT public_orders_order_same_tenant
        FOREIGN KEY (accepted_order_id, organization_id)
        REFERENCES public.orders (id, organization_id)
);

COMMENT ON TABLE public.public_orders IS
    'Requests from the public (0040). A REQUEST, not a sale: it deducts no stock and captures no cost until a member of staff accepts it, at which point the ordinary checkout path runs under a real identity.';

CREATE INDEX public_orders_queue_idx
    ON public.public_orders (organization_id, created_at DESC)
    WHERE status = 'pending';
CREATE INDEX public_orders_org_idx
    ON public.public_orders (organization_id, created_at DESC);

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.public_orders
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE public.public_order_lines (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_order_id  uuid NOT NULL REFERENCES public.public_orders (id) ON DELETE CASCADE,
    organization_id  uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,

    sellable_item_id uuid NOT NULL,
    quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),

    -- Copied from the menu at the moment of ordering, never sent by the client.
    unit_price       numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
    -- Kept so a receipt reads correctly even if the dish is later renamed.
    item_name        text NOT NULL,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT public_order_lines_item_same_tenant
        FOREIGN KEY (sellable_item_id, organization_id)
        REFERENCES public.sellable_items (id, organization_id)
);

COMMENT ON TABLE public.public_order_lines IS
    'What was asked for, priced from the menu (0040) — the client sends item ids and quantities and nothing else. Same rule as 0012, and it matters more here because the caller is anonymous.';

CREATE INDEX public_order_lines_order_idx ON public.public_order_lines (public_order_id);

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON public.public_order_lines
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE public.public_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.public_orders
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));
CREATE POLICY user_belongs_to_org ON public.public_order_lines
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Deciding is floor work — whoever is at the pass when the tablet pings.
CREATE POLICY require_floor_update ON public.public_orders
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_sell(organization_id))
    WITH CHECK (app.user_can_sell(organization_id));

-- NO INSERT policy and NO INSERT grant on either table. Requests arrive only
-- through app.place_public_order, which runs as the owner precisely because
-- there is no identity to bind. A controller that could insert one directly
-- would be a controller that could file an order against any tenant.

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT ON public.storefronts TO mosaiz_app_user;
        GRANT INSERT, UPDATE ON public.storefronts TO mosaiz_app_user;

        GRANT SELECT, UPDATE ON public.public_orders TO mosaiz_app_user;
        GRANT SELECT ON public.public_order_lines TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- The public surface. Three functions, and nothing else is reachable.
-- ----------------------------------------------------------------------------

/**
 * The menu one storefront is offering right now.
 *
 * Takes a SLUG. There is no overload that takes an organization_id, and that
 * is deliberate — the outside world cannot name a tenant any other way.
 */
CREATE FUNCTION app.public_menu(p_slug text)
RETURNS TABLE (item_id uuid, name text, price numeric, restaurant text, greeting text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org uuid;
BEGIN
    SELECT s.organization_id INTO v_org
      FROM public.storefronts s
     WHERE s.slug = lower(btrim(p_slug))
       AND s.is_accepting
       AND app.org_has_module(s.organization_id, 'public_ordering');

    -- A closed shop, a slug that does not exist, and a restaurant that does
    -- not do this at all are ONE answer: nothing. Distinguishing them would
    -- turn this into a directory of who uses the product.
    IF v_org IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT i.id, i.name, i.price, s.display_name, s.greeting
      FROM public.sellable_items i
      JOIN public.storefronts s ON s.organization_id = i.organization_id
     WHERE i.organization_id = v_org
       AND i.is_active
     ORDER BY i.name;
END;
$$;

/**
 * Places a request. Returns the tracking token, and nothing else.
 *
 * p_lines is [{"item_id": uuid, "quantity": int}, ...] — no prices. Anything
 * that is not on that restaurant's active menu is rejected outright rather
 * than skipped, because a customer who is charged for four of five items has
 * been failed quietly.
 */
CREATE FUNCTION app.place_public_order(
    p_slug     text,
    p_name     text,
    p_phone    text,
    p_lines    jsonb,
    p_note     text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_org    uuid;
    v_id     uuid;
    v_token  uuid;
    v_total  numeric(10,2) := 0;
    v_count  int;
    v_line   jsonb;
BEGIN
    SELECT s.organization_id INTO v_org
      FROM public.storefronts s
     WHERE s.slug = lower(btrim(p_slug))
       AND s.is_accepting
       AND app.org_has_module(s.organization_id, 'public_ordering');

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'this restaurant is not taking orders'
            USING ERRCODE = 'object_not_in_prerequisite_state';         -- 55000
    END IF;

    IF p_name IS NULL OR char_length(btrim(p_name)) < 2
       OR p_phone IS NULL OR char_length(btrim(p_phone)) < 5 THEN
        RAISE EXCEPTION 'an order needs a name and a phone number'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
       OR jsonb_array_length(p_lines) = 0 THEN
        RAISE EXCEPTION 'an order needs at least one item'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- A ceiling, because the caller is anonymous and this is a write.
    IF jsonb_array_length(p_lines) > 40 THEN
        RAISE EXCEPTION 'too many items in one order'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.public_orders
        (organization_id, customer_name, customer_phone, note, quoted_total)
    VALUES (v_org, btrim(p_name), btrim(p_phone), left(btrim(p_note), 300), 0)
    RETURNING id, tracking_token INTO v_id, v_token;

    -- Priced from the menu. The jsonb carries ids and quantities; any price a
    -- client sent is simply not read.
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
    LOOP
        INSERT INTO public.public_order_lines
            (public_order_id, organization_id, sellable_item_id, quantity, unit_price, item_name)
        SELECT v_id, v_org, i.id,
               GREATEST(1, LEAST(99, (v_line ->> 'quantity')::int)),
               i.price, i.name
          FROM public.sellable_items i
         WHERE i.id = (v_line ->> 'item_id')::uuid
           AND i.organization_id = v_org
           AND i.is_active;

        GET DIAGNOSTICS v_count = ROW_COUNT;
        IF v_count = 0 THEN
            -- Not on this menu, not active, or belongs to another restaurant.
            -- All three are the same refusal.
            RAISE EXCEPTION 'that item is not on the menu'
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    SELECT COALESCE(SUM(quantity * unit_price), 0) INTO v_total
      FROM public.public_order_lines WHERE public_order_id = v_id;

    UPDATE public.public_orders SET quoted_total = v_total WHERE id = v_id;

    RETURN v_token;
END;
$$;

/**
 * What happened to my order.
 *
 * Returns a status word and the total the customer was quoted. Not the items,
 * not the restaurant's internals, and nothing that would let a token be used
 * to learn anything about anybody else.
 */
CREATE FUNCTION app.public_order_status(p_token uuid)
RETURNS TABLE (status text, quoted_total numeric, placed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT o.status, o.quoted_total, o.created_at
      FROM public.public_orders o
     WHERE o.tracking_token = p_token;
$$;

REVOKE EXECUTE ON FUNCTION app.public_menu(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.place_public_order(text, text, text, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.public_order_status(uuid) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        -- Granted to the application role, which is what the gateway connects
        -- as when serving an anonymous request. This is the ONE place in the
        -- schema where a call runs with no app.current_user_id bound, which is
        -- why all three functions take a slug or a token and nothing else.
        GRANT EXECUTE ON FUNCTION app.public_menu(text) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.place_public_order(text, text, text, jsonb, text) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.public_order_status(uuid) TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Accepting one.
--
-- SECURITY INVOKER — deliberately, and it is the most important word in this
-- migration. Everything else here runs as the owner because the caller has no
-- identity; this runs as the STAFF MEMBER, so the ordinary checkout path
-- applies unchanged: their role, their RLS, their name on the sale. Wrapping
-- it in SECURITY DEFINER would have let an anonymous request reach a
-- stock-deducting procedure with the owner's privileges, which is the exact
-- thing this whole design exists to prevent.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.accept_public_order(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    v_org   uuid;
    v_state text;
    v_coid  uuid := gen_random_uuid();
    v_items jsonb;
    v_order uuid;
BEGIN
    -- Read through RLS: a request in another restaurant's queue is not
    -- visible, so this finds nothing and says so.
    SELECT organization_id, status INTO v_org, v_state
      FROM public.public_orders WHERE id = p_id;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'no such request' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_state <> 'pending' THEN
        RAISE EXCEPTION 'that request was already decided'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
               'sellable_item_id', l.sellable_item_id,
               'quantity', l.quantity))
      INTO v_items
      FROM public.public_order_lines l
     WHERE l.public_order_id = p_id;

    -- The SAME procedure the till uses. Prices are re-read from the menu there
    -- too, so a dish that changed price between the request and the acceptance
    -- is charged at today's price — and the customer's quote is still on
    -- record in quoted_total for whoever has to explain the difference.
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id', v_org,
        'client_offline_id', v_coid,
        'items', v_items));

    SELECT id INTO v_order FROM public.orders
     WHERE organization_id = v_org AND client_offline_id = v_coid;

    UPDATE public.public_orders
       SET status = 'accepted',
           accepted_order_id = v_order,
           decided_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid,
           decided_at = now()
     WHERE id = p_id;

    RETURN v_order;
END;
$$;

/**
 * Turning one down. Needs a reason, for the same purpose an amendment does.
 *
 * Returns the id rather than void: a void-returning function is awkward to
 * call from the gateway, which cannot deserialise the column.
 */
CREATE FUNCTION app.reject_public_order(p_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
        RAISE EXCEPTION 'a rejection needs a reason'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    UPDATE public.public_orders
       SET status = 'rejected',
           rejection_reason = btrim(p_reason),
           decided_by = NULLIF(current_setting('app.current_user_id', true), '')::uuid,
           decided_at = now()
     WHERE id = p_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no pending request with that id'
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN p_id;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.accept_public_order(uuid) TO mosaiz_app_user;
        GRANT EXECUTE ON FUNCTION app.reject_public_order(uuid, text) TO mosaiz_app_user;
    END IF;
END;
$$;

COMMENT ON FUNCTION app.accept_public_order(uuid) IS
    'Turns a request into a sale (0040). SECURITY INVOKER on purpose: it runs as the staff member who accepted it, so the ordinary checkout path, their role and their RLS all apply unchanged. A DEFINER wrapper here would let an anonymous request reach a stock-deducting procedure with the owner''s privileges.';

-- ----------------------------------------------------------------------------
-- The module. Off by default, and dependent on nothing — a restaurant can take
-- orders online without running stock or purchasing.
-- ----------------------------------------------------------------------------
INSERT INTO public.modules (key, name_ar, description_ar, depends_on, enforced_in, default_enabled, sort_order)
VALUES ('public_ordering', 'الطلب أونلاين', 'صفحة عامة للقائمة وطلبات الزبائن',
        '{}', 'database', false, 65);

COMMENT ON FUNCTION app.place_public_order(text, text, text, jsonb, text) IS
    'Files a request from the public (0040). SECURITY DEFINER because the caller has no identity to bind; the tenant comes from the SLUG and prices come from the MENU, so neither is a parameter a stranger can tamper with. The request moves no stock — a human accepts it first.';

COMMIT;
