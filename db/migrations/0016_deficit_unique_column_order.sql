-- ============================================================================
-- Migration 0016: Reorder the inventory_deficits unique so introspection is valid
-- Mosaiz Mundo ERP
--
-- This changes NO behaviour. It exists so that `prisma db pull` produces a
-- schema that validates, which in turn lets CI check the committed schema
-- against the real database automatically.
--
-- The problem it removes:
--   * 0013 added UNIQUE (organization_id, raw_item_id) to inventory_deficits.
--   * That makes the link to raw_inventory_items one-to-one, and Prisma requires
--     the unique to be declared in the SAME field order as the relation's
--     `fields:`, which the foreign key fixes as (raw_item_id, organization_id).
--   * So introspection emitted a schema that failed `prisma generate`, and the
--     committed schema had to be hand-patched after every `db:pull` — a step
--     that was silently skipped after 0013 and left the schema stale for two
--     migrations. CI could not catch it, because "Backend Build" generates from
--     the committed file with no database.
--
-- Reordering the constraint's columns makes the pulled schema correct by
-- construction, so the drift check added in this PR can be trusted.
--
-- Why this is safe:
--   * A UNIQUE over the same two columns enforces identical semantics; only the
--     index's column order differs.
--   * ON CONFLICT infers its target by the SET of columns, not their order, so
--     `ON CONFLICT (organization_id, raw_item_id)` in process_inventory_deduction
--     and post_stocktake keeps matching this constraint. Verified against
--     PostgreSQL 18 before writing this, and covered by the existing deficit
--     assertions in inventory_fifo_verification, bom_integration_verification
--     and cogs_verification, which all exercise the upsert.
--   * The table holds one row per (organization, raw item) — a handful of rows —
--     so the leading-column change has no practical effect on query plans.
--
-- Depends on: 0013 (the constraint this reorders)
-- ============================================================================

BEGIN;

ALTER TABLE public.inventory_deficits
    DROP CONSTRAINT inventory_deficits_org_item_key;

ALTER TABLE public.inventory_deficits
    ADD CONSTRAINT inventory_deficits_org_item_key
    UNIQUE (raw_item_id, organization_id);

COMMENT ON CONSTRAINT inventory_deficits_org_item_key ON public.inventory_deficits IS
    'One running deficit per (organization, raw item). Columns are ordered (raw_item_id, organization_id) to match the foreign key, so Prisma introspection yields a valid schema (0016).';

COMMIT;
