-- ============================================================================
-- Sale attribution verification (0026) — runs as mosaiz_app_user, switching
-- between the cogs fixture's CASHIER and BRANCH MANAGER identities, because the
-- whole claim is that the stamp follows whoever actually rang the sale up.
--
-- Relies on the fixture and the stock state earlier suites leave behind. The
-- quantities are deliberately small: this suite is about WHO, not how much, and
-- pinning stock arithmetic here would make it fail for unrelated reasons.
--
-- Run order: after cost_precision_verification.sql.
-- ============================================================================
\set ON_ERROR_STOP on

-- ----------------------------------------------------------------------------
-- 1. The sale is stamped with the cashier who made it.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_coid   uuid := 'a77140b0-0000-4000-8000-000000000001';
    v_served uuid;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', v_coid,
        'items', jsonb_build_array(jsonb_build_object(
            'sellable_item_id', 'c0575e11-0000-4000-8000-000000000003',
            'quantity', 1))));

    SELECT served_by INTO v_served FROM public.orders WHERE client_offline_id = v_coid;

    IF v_served IS DISTINCT FROM 'c0570001-0000-4000-8000-000000000001'::uuid THEN
        RAISE EXCEPTION 'the sale must be attributed to the cashier who made it, got %',
            COALESCE(v_served::text, 'nobody');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. A DIFFERENT identity gets a different stamp. Section 1 alone would pass
--    against an implementation that hardcoded one user, so the same call is
--    made again as the manager and must land on them instead.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_coid   uuid := 'a77140b0-0000-4000-8000-000000000002';
    v_served uuid;
BEGIN
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', v_coid,
        'items', jsonb_build_array(jsonb_build_object(
            'sellable_item_id', 'c0575e11-0000-4000-8000-000000000003',
            'quantity', 1))));

    SELECT served_by INTO v_served FROM public.orders WHERE client_offline_id = v_coid;

    IF v_served IS DISTINCT FROM 'c0570002-0000-4000-8000-000000000002'::uuid THEN
        RAISE EXCEPTION 'the stamp must follow the actual caller, got %',
            COALESCE(v_served::text, 'nobody');
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. A RETRY DOES NOT RE-STAMP.
--
--    The POS works offline: a sale rung up by one cashier can be synced later,
--    possibly by another device or after a shift change. The checkout INSERT is
--    ON CONFLICT DO NOTHING, so replaying the same client_offline_id must leave
--    the ORIGINAL server in place. Re-attributing on sync would silently move
--    sales onto whoever pressed the button last — and it would look plausible.
--
--    What a counterfactual here actually proves, precisely: rewriting the
--    INSERT to DO UPDATE ... SET served_by does fail this suite, but as a
--    CASHIER it fails on the 0010 require_admin_update policy — the rule that
--    stops a cashier updating an order at all — BEFORE reaching the assertion
--    below. Two independent mechanisms therefore defend this, and the assertion
--    is the one that would still catch a re-stamp by someone whose role does
--    permit updating orders.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570001-0000-4000-8000-000000000001';

DO $$
DECLARE
    v_coid   uuid := 'a77140b0-0000-4000-8000-000000000002';  -- the MANAGER's sale
    v_served uuid;
    v_count  int;
BEGIN
    -- Replayed by the cashier, who did not make this sale.
    CALL app.process_pos_checkout(jsonb_build_object(
        'organization_id',   'c0570000-0000-4000-8000-000000000000',
        'client_offline_id', v_coid,
        'items', jsonb_build_array(jsonb_build_object(
            'sellable_item_id', 'c0575e11-0000-4000-8000-000000000003',
            'quantity', 1))));

    SELECT count(*) INTO v_count FROM public.orders WHERE client_offline_id = v_coid;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'the retry must not create a second order (got % rows)', v_count;
    END IF;

    SELECT served_by INTO v_served FROM public.orders WHERE client_offline_id = v_coid;
    IF v_served IS DISTINCT FROM 'c0570002-0000-4000-8000-000000000002'::uuid THEN
        RAISE EXCEPTION
            'ATTRIBUTION MOVED: a retry re-stamped the sale onto the replaying '
            'user (%). An offline sale synced by another device must keep the '
            'cashier who actually served it', v_served;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. History is not invented. Orders that predate the column stay NULL, and
--    NULL means "nobody recorded this" — not "the owner did it".
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_id     uuid;
    v_served uuid;
BEGIN
    -- An order written directly, as the pre-0026 checkout would have.
    INSERT INTO public.orders (organization_id, client_offline_id, total_amount)
    VALUES ('c0570000-0000-4000-8000-000000000000',
            'a77140b0-0000-4000-8000-0000000000ff', 10)
    RETURNING id INTO v_id;

    SELECT served_by INTO v_served FROM public.orders WHERE id = v_id;
    IF v_served IS NOT NULL THEN
        RAISE EXCEPTION
            'an order with no recorded server must stay NULL, got % — a default '
            'or trigger here would attribute historical sales to someone who '
            'did not make them', v_served;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. served_by and voided_by are INDEPENDENT. A manager voiding a cashier's
--    sale must not move the sale onto the manager: one records who took the
--    money, the other who reversed it, and collapsing them would credit voids
--    to the wrong person in both directions.
-- ----------------------------------------------------------------------------
SET app.current_user_id = 'c0570002-0000-4000-8000-000000000002';

DO $$
DECLARE
    v_order  uuid;
    v_served uuid;
    v_voided uuid;
BEGIN
    SELECT id INTO v_order FROM public.orders
    WHERE client_offline_id = 'a77140b0-0000-4000-8000-000000000001';  -- cashier's sale

    CALL app.void_order(v_order, false, 'wrong_item');

    SELECT served_by, voided_by INTO v_served, v_voided
    FROM public.orders WHERE id = v_order;

    IF v_served IS DISTINCT FROM 'c0570001-0000-4000-8000-000000000001'::uuid THEN
        RAISE EXCEPTION 'voiding must not change who served the sale (got %)', v_served;
    END IF;
    IF v_voided IS DISTINCT FROM 'c0570002-0000-4000-8000-000000000002'::uuid THEN
        RAISE EXCEPTION 'the void must be recorded against the manager (got %)', v_voided;
    END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Structural: nothing may default or infer this column.
--
--    A DEFAULT or a trigger would make every historical order suddenly claim a
--    server, and the performance report would look complete while being partly
--    fiction. Asserted against the catalogue so a later migration cannot add
--    one quietly.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    v_default text;
BEGIN
    SELECT column_default INTO v_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'served_by';

    IF v_default IS NOT NULL THEN
        RAISE EXCEPTION
            'orders.served_by has acquired a default (%): attribution must come '
            'from the authenticated caller at checkout, never from a fallback',
            v_default;
    END IF;
END;
$$;

SELECT 'sale_attribution_verification: all assertions passed' AS result;
