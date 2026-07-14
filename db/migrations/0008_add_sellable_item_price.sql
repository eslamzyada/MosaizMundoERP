-- ============================================================================
-- Migration 0008: Sellable item price
-- Mosaiz Mundo ERP
--
-- Adds a selling price to the catalog so the POS menu can show real prices
-- (previously the client had to fall back to 0.00). Strictly additive:
--   * NOT NULL DEFAULT 0.00 — existing rows backfill to 0.00, no rewrite of
--     dependent objects.
--   * CHECK (price >= 0) — consistent with the other money columns
--     (orders.total_amount, inventory_batches.cost_at_purchase, ...).
--   * No new grant needed: the app role's table-level grant on sellable_items
--     (0005) already covers future columns.
--
-- NOTE: the table lives in `public`, not `app` (the `app` schema holds only the
-- helper functions/procedures). `app.sellable_items` does not exist.
--
-- Depends on: 0005 (sellable_items)
-- ============================================================================

BEGIN;

ALTER TABLE public.sellable_items
    ADD COLUMN price numeric(10,2) NOT NULL DEFAULT 0.00 CHECK (price >= 0);

COMMENT ON COLUMN public.sellable_items.price IS
    'Selling price shown at the POS. Defaults to 0.00 until set.';

COMMIT;
