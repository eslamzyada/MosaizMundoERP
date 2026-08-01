-- ============================================================================
-- Menu fixture — runs as postgres, BEFORE any suite that needs a dish to exist.
--
-- Why this file exists at all: since 0035 the application role has no INSERT or
-- UPDATE on sellable_items. That is the whole point of the approval cycle — the
-- menu cannot be changed by anything the app can issue. The consequence is that
-- suites which used to seed their own menu items as mosaiz_app_user can no
-- longer do so, and their setup moves here, where postgres owns the table.
--
-- The CHECK constraints on the menu are asserted here too, for the same reason:
-- after 0035 the only role that can attempt a bad write is this one, so this is
-- the only place the constraint can still be observed doing its job. Leaving
-- those assertions in an app-role suite would have quietly turned them into
-- "permission denied" — a pass for entirely the wrong reason.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The two items pos_checkout_verification prices and sells.
--    Prices are set HERE, so that suite can assert server-authoritative pricing
--    without needing a write it no longer has.
-- ---------------------------------------------------------------------------
INSERT INTO public.sellable_items (id, organization_id, name, sku, price)
SELECT 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'::uuid, o.id, 'CI Item A', 'ITEM-A1', 24.50
  FROM public.organizations o WHERE o.slug = 'ci-bistro-cairo'
ON CONFLICT (id) DO UPDATE SET price = 24.50;

INSERT INTO public.sellable_items (id, organization_id, name, sku, price)
SELECT 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2'::uuid, o.id, 'CI Item B', 'ITEM-B2', 6.00
  FROM public.organizations o WHERE o.slug = 'ci-bistro-cairo'
ON CONFLICT (id) DO UPDATE SET price = 6.00;

-- ---------------------------------------------------------------------------
-- 2. The constraints that used to be asserted from an app-role suite.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_default  numeric;
    v_rejected boolean := false;
BEGIN
    INSERT INTO public.sellable_items (id, organization_id, name, sku)
    SELECT 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3'::uuid, o.id, 'CI Default Price', 'DEF-1'
      FROM public.organizations o WHERE o.slug = 'ci-bistro-cairo'
    ON CONFLICT (id) DO NOTHING;

    SELECT price INTO v_default FROM public.sellable_items
     WHERE id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
    IF v_default <> 0.00 THEN
        RAISE EXCEPTION 'sellable_items.price should default to 0.00, got %', v_default;
    END IF;

    BEGIN
        UPDATE public.sellable_items SET price = -1
         WHERE id = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
    EXCEPTION WHEN check_violation THEN
        v_rejected := true;
    END;
    IF NOT v_rejected THEN
        RAISE EXCEPTION 'a negative price must still be refused by the CHECK constraint';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Items the BOM and open-tab suites build on.
--    Seeded here rather than inline for the same reason as everything above.
-- ---------------------------------------------------------------------------
INSERT INTO public.sellable_items (id, organization_id, name, sku)
SELECT 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0'::uuid, o.id, 'Burger', 'BURGER-1'
  FROM public.organizations o WHERE o.slug = 'ci-bistro-cairo'
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sellable_items (id, organization_id, name, sku)
SELECT 'c0a1e5ce-0000-4000-8000-00000000000f'::uuid, o.id, 'Coalesce Item', 'COAL-1'
  FROM public.organizations o WHERE o.slug = 'ci-bistro-cairo'
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
    missing text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' AND price = 24.50) THEN
        missing := missing || 'CI Item A at 24.50'; END IF;
    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE id = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2' AND price = 6.00) THEN
        missing := missing || 'CI Item B at 6.00'; END IF;
    IF NOT EXISTS (SELECT FROM public.sellable_items
                    WHERE id = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0') THEN
        missing := missing || 'Burger'; END IF;

    -- Every INSERT above is an INSERT ... SELECT ... WHERE slug = '...', which
    -- writes ZERO rows in silence if that organization is missing. Every suite
    -- downstream would then price against nothing and pass.
    IF array_length(missing, 1) > 0 THEN
        RAISE EXCEPTION 'menu fixture seeded nothing for %: is ci-bistro-cairo missing?',
            array_to_string(missing, ', ');
    END IF;
END;
$$;

SELECT 'menu_fixture: seeded and priced the dishes the app role may no longer write' AS result;
