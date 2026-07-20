import { Prisma } from '@prisma/client';

/**
 * Food cost, in one place.
 *
 * Two screens ask what a dish costs — the recipe editor and the menu, where
 * prices are set. If each computed it its own way they would eventually
 * disagree, and the owner would have no way to tell which number to trust. So
 * the basis lives here and both call it.
 *
 * The basis is the WEIGHTED AVERAGE cost of the stock actually on hand:
 * value / quantity across open lots. That is the same basis as the inventory
 * dashboard's stock value, so those figures reconcile too.
 */

/** Trim floating-point noise without losing a cent. */
export function money(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Weighted-average cost of one unit of each given raw ingredient.
 *
 * Runs on the caller's RLS-bound transaction, so another tenant's lots can
 * never contribute. Lots with nothing left are excluded: an ingredient whose
 * stock is fully consumed has no cost basis (and excluding them is also what
 * keeps the division safe).
 *
 * An ingredient with no open stock is simply ABSENT from the result. Callers
 * must treat that as "unknown", never as zero.
 */
export async function unitCostsByRawItem(
  tx: Prisma.TransactionClient,
  rawItemIds: string[],
): Promise<Map<string, number>> {
  if (rawItemIds.length === 0) {
    return new Map();
  }

  const rows = await tx.$queryRaw<Array<{ raw_item_id: string; unit_cost: unknown }>>`
    SELECT b.raw_item_id,
           SUM(b.quantity_remaining * b.cost_at_purchase)
             / SUM(b.quantity_remaining) AS unit_cost
    FROM public.inventory_batches b
    WHERE b.raw_item_id = ANY(${rawItemIds}::uuid[])
      AND b.quantity_remaining > 0
    GROUP BY b.raw_item_id
    HAVING SUM(b.quantity_remaining) > 0
  `;

  return new Map(rows.map((r) => [r.raw_item_id, Number(r.unit_cost)]));
}

/** One recipe line, as far as costing is concerned. */
export interface CostableLine {
  raw_item_id: string;
  quantity_required: unknown; // Prisma Decimal
}

export interface RecipeCost {
  /**
   * Cost of the lines that could be priced. When `uncosted_line_count` is above
   * zero this is a FLOOR, not the real cost — a dish costed from only some of
   * its ingredients looks cheaper than it is, which is how it gets underpriced.
   */
  total_cost: number;
  uncosted_line_count: number;
  /** 0 means the item has no recipe at all — its cost is unknown, not zero. */
  recipe_line_count: number;
}

/** Totals a set of recipe lines against a unit-cost lookup. */
export function costRecipe(
  lines: CostableLine[],
  unitCostOf: Map<string, number>,
): RecipeCost {
  let total = 0;
  let uncosted = 0;

  for (const line of lines) {
    const unitCost = unitCostOf.get(line.raw_item_id);
    if (unitCost === undefined) {
      uncosted += 1;
      continue;
    }
    total += unitCost * Number(line.quantity_required);
  }

  return {
    total_cost: money(total),
    uncosted_line_count: uncosted,
    recipe_line_count: lines.length,
  };
}

/** Every distinct ingredient referenced by the given recipes. */
export function rawItemIdsOf(recipes: Array<{ bill_of_materials: CostableLine[] }>): string[] {
  return [...new Set(recipes.flatMap((r) => r.bill_of_materials.map((l) => l.raw_item_id)))];
}
