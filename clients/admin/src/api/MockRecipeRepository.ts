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

// A recipe line, with the id the real bill_of_materials row would carry — the
// UI addresses lines by it when editing a quantity or removing an ingredient.
let lineSeq = 0;
function line(rawItemId: string, quantityRequired: number): RecipeLine {
  lineSeq += 1;
  return {
    id: `bom-0000-0000-4000-8000-${String(lineSeq).padStart(12, '0')}`,
    raw_item: ing(rawItemId),
    quantity_required: quantityRequired,
  };
}

// Mock-first: realistic Arabic recipes. No network calls anywhere.
const MOCK_RECIPES: Recipe[] = [
  {
    sellable_item: sellable('s0000001-0000-4000-8000-000000000001', 'شاورما دجاج', 'SHW-01'),
    total_cost: 12.5,
    recipe_lines: [line('r-0001', 200), line('r-0002', 1), line('r-0003', 30), line('r-0004', 20)],
  },
  {
    sellable_item: sellable('s0000002-0000-4000-8000-000000000002', 'برجر لحم', 'BRG-01'),
    total_cost: 18.75,
    recipe_lines: [line('r-0005', 150), line('r-0006', 1), line('r-0007', 25), line('r-0008', 15)],
  },
  {
    sellable_item: sellable('s0000003-0000-4000-8000-000000000003', 'فلافل', 'FLF-01'),
    total_cost: 7.0,
    recipe_lines: [line('r-0009', 120), line('r-0010', 20), line('r-0002', 1)],
  },
  {
    sellable_item: sellable('s0000004-0000-4000-8000-000000000004', 'عصير برتقال طازج', 'JUC-01'),
    total_cost: 9.25,
    recipe_lines: [line('r-0011', 400), line('r-0012', 15)],
  },
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
    const recipe = MOCK_RECIPES.find((r) => r.sellable_item.id === sellableItemId);
    if (recipe && ING.has(payload.raw_item_id)) {
      recipe.recipe_lines.push(line(payload.raw_item_id, payload.quantity_required));
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }

  updateLine(lineId: string, quantityRequired: number): Promise<void> {
    for (const recipe of MOCK_RECIPES) {
      const target = recipe.recipe_lines.find((l) => l.id === lineId);
      if (target) {
        target.quantity_required = quantityRequired;
        break;
      }
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }

  removeLine(lineId: string): Promise<void> {
    for (const recipe of MOCK_RECIPES) {
      const idx = recipe.recipe_lines.findIndex((l) => l.id === lineId);
      if (idx >= 0) {
        recipe.recipe_lines.splice(idx, 1);
        break;
      }
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }
}
