import type { AddRecipeLinePayload, RecipeRepository } from './RecipeRepository';
import type { Recipe, RawInventoryItem, RecipeLine, SellableItem } from '../types';

const ORG = 'org-00000000-0000-4000-8000-000000000001';

// The catalog of raw ingredients available to add to a recipe.
const MOCK_INGREDIENTS: RawInventoryItem[] = [
  { id: 'r-0001', name: 'دجاج', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0002', name: 'خبز عربي', unit_of_measure: 'قطعة', category: 'purchased' },
  { id: 'r-0003', name: 'صلصة ثوم', unit_of_measure: 'جرام', category: 'intermediate' },
  { id: 'r-0004', name: 'مخلل', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0005', name: 'قرص لحم', unit_of_measure: 'جرام', category: 'intermediate' },
  { id: 'r-0006', name: 'خبز برجر', unit_of_measure: 'قطعة', category: 'purchased' },
  { id: 'r-0007', name: 'جبنة شيدر', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0008', name: 'خس', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0009', name: 'حمص', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0010', name: 'بقدونس', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0011', name: 'برتقال', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0012', name: 'سكر', unit_of_measure: 'جرام', category: 'purchased' },
  { id: 'r-0013', name: 'طحينة', unit_of_measure: 'جرام', category: 'intermediate' },
  { id: 'r-0014', name: 'طماطم', unit_of_measure: 'جرام', category: 'purchased' },
];

const ING = new Map(MOCK_INGREDIENTS.map((i) => [i.id, i]));
function ing(id: string): RawInventoryItem {
  return ING.get(id)!;
}

function sellable(id: string, name: string, sku: string): SellableItem {
  return {
    id,
    organization_id: ORG,
    name,
    sku,
    created_at: '2026-07-01T08:00:00.000Z',
    updated_at: '2026-07-10T08:00:00.000Z',
  };
}

// Weighted-average cost of one unit of each ingredient, as the API derives it
// from stock on hand. `null` means there is no stock to price it from — بقدونس
// is deliberately unpriced so the "incomplete cost" state is exercised offline.
const UNIT_COST: Record<string, number | null> = {
  'r-0001': 0.05,
  'r-0002': 2.0,
  'r-0003': 0.08,
  'r-0004': 0.03,
  'r-0005': 0.09,
  'r-0006': 3.0,
  'r-0007': 0.2,
  'r-0008': 0.02,
  'r-0009': 0.04,
  'r-0010': null,
  'r-0011': 0.02,
  'r-0012': 0.01,
  'r-0013': 0.15,
  'r-0014': 0.03,
};

// A recipe line, with the id the real bill_of_materials row would carry — the
// UI addresses lines by it when editing a quantity or removing an ingredient.
let lineSeq = 0;
function line(rawItemId: string, quantityRequired: number): RecipeLine {
  lineSeq += 1;
  const unitCost = UNIT_COST[rawItemId] ?? null;
  return {
    id: `bom-0000-0000-4000-8000-${String(lineSeq).padStart(12, '0')}`,
    raw_item: ing(rawItemId),
    quantity_required: quantityRequired,
    unit_cost: unitCost,
    line_cost: unitCost === null ? null : round(unitCost * quantityRequired),
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Derives total_cost and uncosted_line_count from the lines the same way the
// API does, so the mock cannot drift into claiming a cost it hasn't accounted for.
function recipe(sellableItem: SellableItem, price: number, lines: RecipeLine[]): Recipe {
  return {
    sellable_item: sellableItem,
    recipe_lines: lines,
    total_cost: round(lines.reduce((sum, l) => sum + (l.line_cost ?? 0), 0)),
    uncosted_line_count: lines.filter((l) => l.line_cost === null).length,
    price,
  };
}

// Mock-first: realistic Arabic recipes. No network calls anywhere.
const MOCK_RECIPES: Recipe[] = [
  recipe(sellable('s0000001-0000-4000-8000-000000000001', 'شاورما دجاج', 'SHW-01'), 45, [
    line('r-0001', 200),
    line('r-0002', 1),
    line('r-0003', 30),
    line('r-0004', 20),
  ]),
  recipe(sellable('s0000002-0000-4000-8000-000000000002', 'برجر لحم', 'BRG-01'), 60, [
    line('r-0005', 150),
    line('r-0006', 1),
    line('r-0007', 25),
    line('r-0008', 15),
  ]),
  // Contains بقدونس, which has no stock to price — this recipe stays incomplete.
  recipe(sellable('s0000003-0000-4000-8000-000000000003', 'فلافل', 'FLF-01'), 25, [
    line('r-0009', 120),
    line('r-0010', 20),
    line('r-0002', 1),
  ]),
  recipe(sellable('s0000004-0000-4000-8000-000000000004', 'عصير برتقال طازج', 'JUC-01'), 22, [
    line('r-0011', 400),
    line('r-0012', 15),
  ]),
];

export class MockRecipeRepository implements RecipeRepository {
  getRecipes(): Promise<Recipe[]> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(MOCK_RECIPES), 400);
    });
  }

  getIngredients(): Promise<RawInventoryItem[]> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(MOCK_INGREDIENTS), 200);
    });
  }

  addIngredient(sellableItemId: string, payload: AddRecipeLinePayload): Promise<void> {
    const target = MOCK_RECIPES.find((r) => r.sellable_item.id === sellableItemId);
    if (target && ING.has(payload.raw_item_id)) {
      target.recipe_lines.push(line(payload.raw_item_id, payload.quantity_required));
      recost(target);
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }

  updateLine(lineId: string, quantityRequired: number): Promise<void> {
    for (const r of MOCK_RECIPES) {
      const target = r.recipe_lines.find((l) => l.id === lineId);
      if (target) {
        target.quantity_required = quantityRequired;
        target.line_cost =
          target.unit_cost === null ? null : round(target.unit_cost * quantityRequired);
        recost(r);
        break;
      }
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }

  removeLine(lineId: string): Promise<void> {
    for (const r of MOCK_RECIPES) {
      const idx = r.recipe_lines.findIndex((l) => l.id === lineId);
      if (idx >= 0) {
        r.recipe_lines.splice(idx, 1);
        recost(r);
        break;
      }
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }
}

// Editing a recipe changes its cost — recompute so the mock never shows a total
// that no longer matches its lines.
function recost(r: Recipe): void {
  r.total_cost = round(r.recipe_lines.reduce((sum, l) => sum + (l.line_cost ?? 0), 0));
  r.uncosted_line_count = r.recipe_lines.filter((l) => l.line_cost === null).length;
}
