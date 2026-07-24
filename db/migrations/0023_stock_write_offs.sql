-- ============================================================================
-- Migration 0023: Write stock off, with a reason
-- Mosaiz Mundo ERP
--
-- Stock can currently leave inventory in exactly three ways: a sale draws it
-- down (0007/0015), a stocktake corrects it (0019), and a void puts some back
-- (0018). Nothing records stock that is simply THROWN AWAY — and restaurants
-- throw away food every single day.
--
-- The consequences compound quietly:
--   * The books keep counting binned stock as available, so the till's
--     portions_available (0054) overstates what the kitchen can actually make.
--   * Food cost is understated, because the ingredients that went in the bin
--     never appear as cost anywhere. Margin looks better than it is.
--   * Weeks later a stocktake finds a variance with no cause attached — the
--     same unreadable event that void reasons (0022) exist to prevent, except
--     against money that is genuinely gone rather than usually recoverable.
--
-- inventory_batches.expiry_date has existed since 0005 and 0018 goes out of its
-- way to preserve it on a restore, yet NOTHING in the system has ever read it.
-- This is the migration that gives it a purpose.
--
-- WHY A FIXED VOCABULARY, not free text: the whole value is telling causes
-- apart. 'expired' means over-ordering or a slow-moving menu item; 'spoiled'
-- means storage failed; 'prep_error' means training. Those are three different
-- fixes, and free text collapses them into an uncountable pile.
--
-- staff_meal is included on purpose even though it is not waste. Stock that
-- leaves for a legitimate reason must still leave the books, or it becomes
-- mystery shrinkage that a stocktake later reports as loss.
--
-- A SPECIFIC LOT OR FIFO — both, because either alone is wrong half the time.
-- Expiry is inherently lot-specific: you bin THAT crate, the one that went out
-- of date, not "3kg by FIFO" which would take the freshest-dated stock first.
-- Spillage and prep errors have no lot: the cook does not know which delivery
-- the flour came from, and FIFO is the honest default. p_batch_id selects the
-- first behaviour, omitting it selects the second.
--
-- WRITING OFF MORE THAN THE BOOKS HOLD is not an error. It means the books
-- understated what was physically there, which is a real and common situation.
-- Refusing would block a legitimate write-off at an awkward moment, so the
-- procedure draws what exists and records the remainder in inventory_deficits —
-- the same reconciliation surface a short sale uses (0013), so stocktake has
-- one place to look rather than two.
--
-- AUTHORIZATION: admin-only, matching voiding. Both destroy recorded value, and
-- an unrestricted write-off is a clean way to mask theft. The cost is real —
-- a cook who spots spoiled stock cannot record it themselves — and the natural
-- follow-up is the till's manager-override pattern (a staff member reports, a
-- manager authorises). That is deliberately left to a later phase rather than
-- guessed at now.
--
-- Depends on: 0005 (batches), 0010 (role policies), 0013 (deficits)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The write-off event: one row per "this much of this ingredient was
--    discarded, for this reason".
-- ----------------------------------------------------------------------------
CREATE TABLE public.stock_write_offs (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      uuid NOT NULL,
    raw_item_id          uuid NOT NULL,

    -- What was asked for, what actually came off the shelf, and the difference.
    -- All three are stored rather than derived so the CHECK below can make the
    -- arithmetic a database guarantee instead of an application convention.
    quantity_requested   numeric(10, 3) NOT NULL CHECK (quantity_requested > 0),
    quantity_written_off numeric(10, 3) NOT NULL CHECK (quantity_written_off >= 0),
    quantity_short       numeric(10, 3) NOT NULL DEFAULT 0 CHECK (quantity_short >= 0),

    -- Sum of the lines' (quantity * unit_cost): what this loss actually cost,
    -- priced from the lots it came out of, exactly like cost_at_sale (0015).
    total_cost           numeric(12, 2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),

    reason               text NOT NULL,
    note                 text,
    written_off_by       uuid REFERENCES public.users (id),

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- Composite target so the lines can carry organization_id and have it
    -- enforced rather than trusted.
    CONSTRAINT stock_write_offs_org_unique UNIQUE (id, organization_id),

    CONSTRAINT stock_write_offs_raw_item_fkey
        FOREIGN KEY (raw_item_id, organization_id)
        REFERENCES public.raw_inventory_items (id, organization_id),

    -- The three quantities must agree. Without this, a bug could report a
    -- shortfall that does not match what was drawn and nothing would notice.
    CONSTRAINT stock_write_offs_quantities_balance
        CHECK (quantity_requested = quantity_written_off + quantity_short),

    -- The vocabulary. Source of truth; the API's constant is asserted against
    -- it by a backend drift test, exactly as with void reasons (0022).
    CONSTRAINT stock_write_offs_reason_check
        CHECK (reason IN (
            'expired',      -- passed its expiry date       -> over-ordering
            'spoiled',      -- went bad before that date    -> storage failure
            'damaged',      -- dropped, crushed, punctured  -> handling
            'prep_error',   -- ruined during preparation    -> training
            'staff_meal',   -- eaten by staff; not a loss, but not a sale
            'other'         -- requires a note
        )),

    -- The escape hatch has to explain itself, or it becomes the default and the
    -- five real causes stop meaning anything. Whitespace is not an explanation.
    CONSTRAINT stock_write_offs_note_required_for_other
        CHECK (reason <> 'other' OR btrim(coalesce(note, '')) <> ''),

    CONSTRAINT stock_write_offs_note_wellformed
        CHECK (note IS NULL OR char_length(note) <= 500)
);

COMMENT ON TABLE public.stock_write_offs IS
    'Stock discarded outside a sale (0023): expiry, spoilage, damage, prep errors, staff meals. One row per event; the lots it came out of are in stock_write_off_lines.';
COMMENT ON COLUMN public.stock_write_offs.quantity_short IS
    'The part that could not be drawn because the books held less than was physically discarded. Recorded in inventory_deficits too, for stocktake to reconcile.';
COMMENT ON COLUMN public.stock_write_offs.total_cost IS
    'What the discarded stock cost, summed from the lots it came out of at their cost_at_purchase. A historical fact; it does not move when prices do.';

CREATE TRIGGER trg_stock_write_offs_updated_at
    BEFORE UPDATE ON public.stock_write_offs
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- "What did we throw away last month, and why" scans by time and groups by
-- reason. Organization leads because RLS filters by it first.
CREATE INDEX stock_write_offs_reporting_idx
    ON public.stock_write_offs (organization_id, created_at DESC, reason);
CREATE INDEX stock_write_offs_raw_item_idx
    ON public.stock_write_offs (raw_item_id);

-- ----------------------------------------------------------------------------
-- 2. Which lots it actually came out of.
--
--    Per-lot rows rather than one aggregate, for the same reasons the
--    consumption ledger (0017) keeps them: FIFO lots have different costs, so
--    the cost is only exact per lot; and "which supplier's stock keeps
--    spoiling" is answerable only if the lot is known.
-- ----------------------------------------------------------------------------
CREATE TABLE public.stock_write_off_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    write_off_id    uuid NOT NULL,
    batch_id        uuid NOT NULL REFERENCES public.inventory_batches (id),
    quantity        numeric(10, 3) NOT NULL CHECK (quantity > 0),
    -- The lot's cost_at_purchase copied at the moment of the write-off.
    unit_cost       numeric(10, 2) NOT NULL CHECK (unit_cost >= 0),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT stock_write_off_lines_parent_fkey
        FOREIGN KEY (write_off_id, organization_id)
        REFERENCES public.stock_write_offs (id, organization_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.stock_write_off_lines IS
    'Which lot each discarded quantity came out of, and what it cost (0023). One row per (write-off, lot).';

CREATE TRIGGER trg_stock_write_off_lines_updated_at
    BEFORE UPDATE ON public.stock_write_off_lines
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE INDEX stock_write_off_lines_parent_idx
    ON public.stock_write_off_lines (write_off_id);
-- The recall / supplier-quality question: what happened to this lot?
CREATE INDEX stock_write_off_lines_batch_idx
    ON public.stock_write_off_lines (batch_id);

-- ----------------------------------------------------------------------------
-- 3. Tenant isolation and role gating.
--    ENABLE, never FORCE — FORCE would break the SECURITY DEFINER helpers.
-- ----------------------------------------------------------------------------
ALTER TABLE public.stock_write_offs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_write_off_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_belongs_to_org ON public.stock_write_offs
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

CREATE POLICY user_belongs_to_org ON public.stock_write_off_lines
    FOR ALL
    USING      (app.user_belongs_to_org(organization_id))
    WITH CHECK (app.user_belongs_to_org(organization_id));

-- Admin-only, like voiding. The permissive policy above would otherwise let any
-- member discard stock, and destroying recorded value is a manager's act.
CREATE POLICY require_admin_insert ON public.stock_write_offs
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

CREATE POLICY require_admin_insert ON public.stock_write_off_lines
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (app.user_can_administer(organization_id));

-- SELECT and INSERT only. A write-off is a financial record: it is never
-- edited, and never deleted except with its parent (ON DELETE CASCADE). No
-- DELETE privilege is granted at all, so — unlike 0014 and 0019 — no
-- RESTRICTIVE delete gate is needed to hold the FOR ALL policy back.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT SELECT, INSERT ON public.stock_write_offs      TO mosaiz_app_user;
        GRANT SELECT, INSERT ON public.stock_write_off_lines TO mosaiz_app_user;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. The write-off itself.
--
--    A FUNCTION rather than a procedure so the caller gets the new id back in
--    one round trip (app.accept_invitation sets the same precedent). SECURITY
--    INVOKER, like checkout and void, so the RESTRICTIVE policy above applies
--    to the actual caller — a non-admin's INSERT is refused by the database
--    with 42501, which is the real boundary, not the API's role check.
-- ----------------------------------------------------------------------------
CREATE FUNCTION app.write_off_stock(
    p_raw_item_id uuid,
    p_quantity    numeric,
    p_reason      text,
    p_note        text DEFAULT NULL,
    p_batch_id    uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_org        uuid;
    v_remaining  numeric := p_quantity;
    v_take       numeric;
    v_cost       numeric := 0;
    v_batch      record;
    v_write_off  uuid;
    v_note       text;
    -- The lots drawn, buffered until the header exists. The header is written
    -- ONCE, with its final figures, because the table grants no UPDATE: a
    -- write-off is a historical record, and a two-phase "insert zeroes then
    -- patch them" would have required making it editable to work at all.
    v_draws      jsonb := '[]'::jsonb;
BEGIN
    IF p_raw_item_id IS NULL OR p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'write_off_stock requires a raw item and a positive quantity'
            USING ERRCODE = 'invalid_parameter_value';               -- 22023
    END IF;
    IF p_reason IS NULL OR btrim(p_reason) = '' THEN
        -- Checked ahead of everything so the caller is told the argument is
        -- missing rather than meeting it as a constraint violation later. WHICH
        -- values are legal is left to the CHECK — one list, in one place.
        RAISE EXCEPTION 'write_off_stock requires a reason'
            USING ERRCODE = 'invalid_parameter_value';               -- 22023
    END IF;

    -- Blank is not a note, so the "required for other" CHECK cannot be
    -- satisfied with spaces.
    v_note := NULLIF(btrim(p_note), '');

    -- The ingredient must be visible to this caller; RLS makes another tenant's
    -- item simply absent, which is reported as not-found rather than forbidden
    -- so ids cannot be probed across tenants.
    SELECT organization_id INTO v_org
    FROM public.raw_inventory_items WHERE id = p_raw_item_id;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'ingredient % not found in this organization', p_raw_item_id
            USING ERRCODE = 'no_data_found';                         -- P0002
    END IF;

    -- Refuse a non-admin HERE, before any stock is touched. The RESTRICTIVE
    -- insert policy below is still the real boundary — this check is the early,
    -- legible version of the same rule, and it uses the very same helper so the
    -- two cannot disagree. Without it the FIFO walk would move stock and only
    -- then be refused: harmless, since the whole function is one transaction and
    -- rolls back, but it would take locks and do work on behalf of someone who
    -- was never allowed to ask.
    IF NOT app.user_can_administer(v_org) THEN
        RAISE EXCEPTION 'writing stock off is limited to managers'
            USING ERRCODE = 'insufficient_privilege';                -- 42501
    END IF;

    -- Serialize against sales and stocktakes on this exact ingredient, using the
    -- key every other stock mover uses so the lock actually collides.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_' || p_raw_item_id::text));

    FOR v_batch IN
        SELECT id, quantity_remaining, cost_at_purchase
        FROM public.inventory_batches
        WHERE raw_item_id = p_raw_item_id
          AND organization_id = v_org
          AND quantity_remaining > 0
          -- When a lot is named, draw from that one alone. Expiry is the reason
          -- this exists: the crate that went out of date is not necessarily the
          -- one FIFO would reach for.
          AND (p_batch_id IS NULL OR id = p_batch_id)
        ORDER BY expiry_date ASC NULLS LAST, received_at ASC
        FOR UPDATE
    LOOP
        EXIT WHEN v_remaining <= 0;

        v_take := LEAST(v_batch.quantity_remaining, v_remaining);

        UPDATE public.inventory_batches
        SET quantity_remaining = quantity_remaining - v_take
        WHERE id = v_batch.id;

        v_draws := v_draws || jsonb_build_object(
            'batch_id',  v_batch.id,
            'quantity',  v_take,
            'unit_cost', v_batch.cost_at_purchase);

        v_cost      := v_cost + (v_take * v_batch.cost_at_purchase);
        v_remaining := v_remaining - v_take;
    END LOOP;

    -- A named lot that does not exist, belongs to another ingredient, or is
    -- already empty draws nothing. Saying so is better than silently recording a
    -- write-off of zero against a full shortfall.
    IF p_batch_id IS NOT NULL AND v_remaining = p_quantity THEN
        RAISE EXCEPTION 'lot % has no stock of ingredient % to write off',
            p_batch_id, p_raw_item_id
            USING ERRCODE = 'object_not_in_prerequisite_state';      -- 55000
    END IF;

    -- The header, written once and final. This is also the INSERT the
    -- RESTRICTIVE admin policy gates, so the explicit check above and the policy
    -- both have to pass.
    INSERT INTO public.stock_write_offs
        (organization_id, raw_item_id, quantity_requested, quantity_written_off,
         quantity_short, total_cost, reason, note, written_off_by)
    VALUES
        (v_org, p_raw_item_id, p_quantity, p_quantity - v_remaining, v_remaining,
         v_cost, p_reason, v_note,
         NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    RETURNING id INTO v_write_off;

    INSERT INTO public.stock_write_off_lines
        (organization_id, write_off_id, batch_id, quantity, unit_cost)
    SELECT v_org,
           v_write_off,
           (d ->> 'batch_id')::uuid,
           (d ->> 'quantity')::numeric,
           (d ->> 'unit_cost')::numeric
    FROM jsonb_array_elements(v_draws) AS d;

    IF v_remaining > 0 THEN
        -- More was discarded than the books held: the books understated what was
        -- physically there. Recorded on the same reconciliation surface a short
        -- sale uses, so stocktake has one place to look.
        INSERT INTO public.inventory_deficits
            (organization_id, raw_item_id, missing_quantity)
        VALUES (v_org, p_raw_item_id, v_remaining)
        ON CONFLICT (organization_id, raw_item_id) DO UPDATE
            SET missing_quantity =
                public.inventory_deficits.missing_quantity + excluded.missing_quantity;

        RAISE NOTICE 'write-off exceeded recorded stock: item % short by %',
            p_raw_item_id, v_remaining;
    END IF;

    RETURN v_write_off;
END;
$$;

COMMENT ON FUNCTION app.write_off_stock(uuid, numeric, text, text, uuid) IS
    'Discards stock outside a sale and records why (0023). Draws from a named lot when p_batch_id is given (expiry), otherwise FIFO. Captures cost per lot; records any excess over recorded stock as an inventory deficit. Admin-only via the RESTRICTIVE insert policy; SECURITY INVOKER. Returns the write-off id.';

-- ----------------------------------------------------------------------------
-- 5. Privileges, per convention.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.write_off_stock(uuid, numeric, text, text, uuid) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mosaiz_app_user') THEN
        GRANT EXECUTE ON FUNCTION app.write_off_stock(uuid, numeric, text, text, uuid)
            TO mosaiz_app_user;
    END IF;
END;
$$;

COMMIT;
