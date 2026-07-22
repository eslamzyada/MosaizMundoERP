-- ============================================================================
-- Migration 0021: Purchase orders — what was ordered, and what actually arrived
-- Mosaiz Mundo ERP
--
-- 0020 recorded who supplied each lot, but only once the stock was already in
-- the building. Nothing existed before delivery, so there was no answer to
-- "what have we got on order", no expected date to chase, and no way to notice
-- that 80kg arrived against 100kg ordered — the short 20 simply never appeared
-- anywhere, because a lot records what came, never what was promised.
--
-- An order is therefore two numbers per line: quantity_ordered, set when the
-- order is placed, and quantity_received, accumulated as deliveries arrive. The
-- gap between them IS the outstanding position, and a gap that never closes is
-- a short delivery.
--
-- STATUS: draft -> placed -> received, or cancelled from either.
--   draft     being written; not yet a commitment, and cannot be received against
--   placed    sent to the supplier; this is what "outstanding" means
--   received  every line met or exceeded its ordered quantity
--   cancelled abandoned; stock already received against it is NOT unwound,
--             because that stock is physically in the building
-- A partly delivered order stays 'placed'. It is still outstanding, which is
-- the question the status exists to answer — a separate "partial" status would
-- split the one list an owner actually wants.
--
-- OVER-DELIVERY IS RECORDED, NOT REFUSED. If 105kg arrives against 100kg
-- ordered, the shelf holds 105kg. Rejecting it would force the user to either
-- lie about the quantity or leave real stock unrecorded, and both corrupt
-- inventory worse than an over-delivery does. quantity_received may exceed
-- quantity_ordered, and the UI shows it.
--
-- THE RECEIVED PRICE MAY DIFFER FROM THE ORDERED PRICE. Suppliers quote one
-- figure and invoice another; that difference is precisely the thing 0020's
-- price history exists to expose. So a receipt carries its own cost, defaulting
-- to the agreed price but not bound to it.
--
-- Depends on: 0005 (inventory_batches), 0010 (role predicates), 0020 (suppliers)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The order.
-- ----------------------------------------------------------------------------
CREATE TABLE public.purchase_orders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- No direct FK to organizations, deliberately. The composite supplier FK
    -- below requires (supplier_id, organization_id) to exist in suppliers, whose
    -- own organization_id references organizations — so a bad organization_id
    -- is already impossible, transitively. Every other child table here
    -- (bill_of_materials, order_items, stocktake_items) relies on the same
    -- reasoning. A redundant direct FK would also make organization_id part of
    -- THREE relations, which stops Prisma from letting the column be set
    -- directly and forces every insert through nested connect syntax.
    organization_id uuid NOT NULL,
    supplier_id     uuid NOT NULL,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'placed', 'received', 'cancelled')),
    -- When delivery is expected. Nullable: plenty of orders are placed without
    -- a firm date, and a required field would be filled with a guess.
    expected_at     timestamptz,
    placed_at       timestamptz,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT purchase_orders_supplier_fkey
        FOREIGN KEY (supplier_id, organization_id)
        REFERENCES public.suppliers (id, organization_id),
    -- Lets a line prove it belongs to an order in its OWN organization.
    CONSTRAINT purchase_orders_id_organization_id_key UNIQUE (id, organization_id)
);

COMMENT ON TABLE public.purchase_orders IS
    'What has been ordered from a supplier. A ''placed'' order is outstanding until every line is met (0021).';

CREATE INDEX purchase_orders_status_idx
    ON public.purchase_orders (organization_id, status, expected_at);

CREATE TRIGGER trg_purchase_orders_updated_at
    BEFORE UPDATE ON public.purchase_orders
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. The lines.
-- ----------------------------------------------------------------------------
CREATE TABLE public.purchase_order_lines (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id uuid NOT NULL,
    organization_id   uuid NOT NULL,
    raw_item_id       uuid NOT NULL,
    quantity_ordered  numeric(10, 3) NOT NULL CHECK (quantity_ordered > 0),
    -- What the supplier agreed to charge. The receipt may differ; see the header.
    unit_price        numeric(10, 2) NOT NULL CHECK (unit_price >= 0),
    -- Accumulated across deliveries. May exceed quantity_ordered (over-delivery).
    quantity_received numeric(10, 3) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT purchase_order_lines_order_fkey
        FOREIGN KEY (purchase_order_id, organization_id)
        REFERENCES public.purchase_orders (id, organization_id) ON DELETE CASCADE,
    CONSTRAINT purchase_order_lines_raw_item_fkey
        FOREIGN KEY (raw_item_id, organization_id)
        REFERENCES public.raw_inventory_items (id, organization_id),
    -- One line per ingredient per order: two lines for the same item would make
    -- "how much of this is outstanding" ambiguous.
    CONSTRAINT purchase_order_lines_order_item_key UNIQUE (purchase_order_id, raw_item_id),
    CONSTRAINT purchase_order_lines_id_organization_id_key UNIQUE (id, organization_id)
);

COMMENT ON COLUMN public.purchase_order_lines.quantity_received IS
    'Accumulated across deliveries. Below quantity_ordered means outstanding; above it means the supplier over-delivered, which is recorded rather than refused (0021).';

CREATE INDEX purchase_order_lines_order_idx
    ON public.purchase_order_lines (purchase_order_id);

CREATE TRIGGER trg_purchase_order_lines_updated_at
    BEFORE UPDATE ON public.purchase_order_lines
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Which line a stock lot came from.
--
--    quantity_received gives the total; this gives the detail — three drops of
--    30, 30 and 20 against a 100 order are distinguishable from one drop of 80,
--    which matters when querying a supplier about what they actually sent.
--    Nullable: stock received outside any order (0020's direct path), found
--    stock, and every lot predating this migration have no line.
-- ----------------------------------------------------------------------------
ALTER TABLE public.inventory_batches
    ADD COLUMN purchase_order_line_id uuid;

ALTER TABLE public.inventory_batches
    ADD CONSTRAINT inventory_batches_po_line_fkey
    FOREIGN KEY (purchase_order_line_id, organization_id)
    REFERENCES public.purchase_order_lines (id, organization_id);

COMMENT ON COLUMN public.inventory_batches.purchase_order_line_id IS
    'The order line this lot was delivered against, when it came from a purchase order (0021). NULL for direct receipts, found stock, and pre-0021 lots.';

CREATE INDEX inventory_batches_po_line_idx
    ON public.inventory_batches (purchase_order_line_id);

-- ----------------------------------------------------------------------------
-- 4. Tenant isolation and role gating, per the standing convention. Reads stay
--    open — an accountant checking what is committed needs to see orders.
--    No DELETE: a cancelled order is kept, because what was ordered and then
--    abandoned is part of the purchasing record.
-- ----------------------------------------------------------------------------
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.purchase_orders
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

CREATE POLICY require_admin_insert ON public.purchase_orders
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.purchase_orders
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY user_belongs_to_org ON public.purchase_order_lines
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

CREATE POLICY require_admin_insert ON public.purchase_order_lines
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_update ON public.purchase_order_lines
    AS RESTRICTIVE FOR UPDATE
    USING      (app.user_can_administer(organization_id))
    WITH CHECK (app.user_can_administer(organization_id));

-- A draft's lines are edited before placing, so DELETE is needed there — and,
-- because the permissive policy above is FOR ALL and therefore covers DELETE,
-- the grant ships with its own RESTRICTIVE gate (the pairing 0014 established).
CREATE POLICY require_admin_delete ON public.purchase_order_lines
    AS RESTRICTIVE FOR DELETE
    USING (app.user_can_administer(organization_id));

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON public.purchase_orders TO mosaiz_app_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_order_lines TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Receiving a delivery.
--
--    Three writes have to agree: the stock lot appears, the line's received
--    total rises, and the order closes once every line is met. Doing that from
--    the API would leave the totals able to drift from the lots that justify
--    them, so it is one procedure — and it takes the SAME per-ingredient
--    advisory lock as checkout and stocktake, so a delivery landing mid-service
--    cannot interleave with a sale drawing the same item down.
--
--    SECURITY INVOKER, like the other operational procedures: the INSERT and
--    UPDATE run as the caller, so the 0010/0021 policies decide whether a
--    delivery may be recorded at all.
-- ----------------------------------------------------------------------------
CREATE PROCEDURE app.receive_purchase_order_line(
    p_line_id       uuid,
    p_quantity      numeric,
    p_unit_cost     numeric DEFAULT NULL,
    p_expiry_date   timestamptz DEFAULT NULL
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_line        record;
    v_order       record;
    v_cost        numeric;
    v_outstanding integer;
BEGIN
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'a received quantity must be positive (got %)', p_quantity;
    END IF;

    SELECT l.id, l.organization_id, l.purchase_order_id, l.raw_item_id, l.unit_price
      INTO v_line
    FROM public.purchase_order_lines l
    WHERE l.id = p_line_id;

    IF v_line.id IS NULL THEN
        RAISE EXCEPTION 'purchase order line % not found', p_line_id
            USING ERRCODE = 'no_data_found';                       -- P0002
    END IF;

    SELECT o.id, o.status, o.supplier_id INTO v_order
    FROM public.purchase_orders o
    WHERE o.id = v_line.purchase_order_id;

    -- Only a placed order can take delivery: a draft is not yet a commitment,
    -- and a cancelled or completed one should not quietly reopen.
    IF v_order.status <> 'placed' THEN
        RAISE EXCEPTION 'cannot receive against a % purchase order', v_order.status
            USING ERRCODE = 'object_not_in_prerequisite_state';    -- 55000
    END IF;

    -- Serialize with sales and stocktakes on this exact ingredient.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || v_line.raw_item_id::text));

    -- The invoice may differ from the quote; that difference is the signal
    -- 0020's price history exists to surface, so it is recorded as it arrives.
    v_cost := COALESCE(p_unit_cost, v_line.unit_price);
    IF v_cost < 0 THEN
        RAISE EXCEPTION 'a received unit cost cannot be negative (got %)', v_cost;
    END IF;

    INSERT INTO public.inventory_batches
        (organization_id, raw_item_id, quantity_received, quantity_remaining,
         cost_at_purchase, expiry_date, supplier_id, purchase_order_line_id)
    VALUES (v_line.organization_id, v_line.raw_item_id, p_quantity, p_quantity,
            v_cost, p_expiry_date, v_order.supplier_id, v_line.id);

    UPDATE public.purchase_order_lines
    SET quantity_received = quantity_received + p_quantity
    WHERE id = v_line.id;

    -- Close the order once nothing is still owed. Over-delivery counts as met.
    SELECT count(*) INTO v_outstanding
    FROM public.purchase_order_lines
    WHERE purchase_order_id = v_line.purchase_order_id
      AND quantity_received < quantity_ordered;

    IF v_outstanding = 0 THEN
        UPDATE public.purchase_orders SET status = 'received'
        WHERE id = v_line.purchase_order_id;
    END IF;
END;
$$;

COMMENT ON PROCEDURE app.receive_purchase_order_line(uuid, numeric, numeric, timestamptz) IS
    'Records a delivery against a purchase order line: creates the stock lot (attributed to the order''s supplier), adds to the line''s received total, and closes the order when every line is met (0021). SECURITY INVOKER.';

REVOKE ALL ON PROCEDURE
    app.receive_purchase_order_line(uuid, numeric, numeric, timestamptz) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON PROCEDURE
            app.receive_purchase_order_line(uuid, numeric, numeric, timestamptz)
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
