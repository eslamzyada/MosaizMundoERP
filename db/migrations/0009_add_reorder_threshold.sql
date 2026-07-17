-- ============================================================================
-- Migration 0009: Raw item reorder threshold
-- Mosaiz Mundo ERP
--
-- Adds the per-item minimum that the inventory dashboard compares on-hand
-- stock against, so "low stock" is a property of the ingredient rather than a
-- hardcoded rule in the client (chicken and salt do not share a sensible
-- threshold). Strictly additive:
--   * NOT NULL DEFAULT 0 — existing rows backfill to 0, which disables the
--     alert for them; no rewrite of dependent objects.
--   * CHECK (reorder_threshold >= 0) — a negative minimum is meaningless, and
--     this mirrors the other quantity columns (inventory_batches.*).
--   * numeric(10,3) — same precision/scale as the quantity columns it is
--     compared against (quantity_remaining, quantity_required).
--   * No new grant needed: the app role's table-level grant on
--     raw_inventory_items (0006) already covers future columns.
--
-- Depends on: 0006 (raw_inventory_items)
-- ============================================================================

BEGIN;

ALTER TABLE public.raw_inventory_items
    ADD COLUMN reorder_threshold numeric(10,3) NOT NULL DEFAULT 0
        CHECK (reorder_threshold >= 0);

COMMENT ON COLUMN public.raw_inventory_items.reorder_threshold IS
    'Minimum on-hand quantity before the item is flagged for reorder. 0 disables the alert.';

COMMIT;
