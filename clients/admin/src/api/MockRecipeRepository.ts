import type { RecipeRepository } from './RecipeRepository';
import type { Recipe, SellableItem } from '../types';

const ORG = 'org-00000000-0000-4000-8000-000000000001';

// Helper to keep the mock sellable items terse but shape-accurate.
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

// Mock-first: realistic Arabic recipes. No network calls anywhere.
const MOCK_RECIPES: Recipe[] = [
  {
    sellable_item: sellable('s0000001-0000-4000-8000-000000000001', 'شاورما دجاج', 'SHW-01'),
    total_cost: 12.5,
    recipe_lines: [
      {
        raw_item: { id: 'r-0001', name: 'دجاج', unit_of_measure: 'جرام' },
        quantity_required: 200,
      },
      {
        raw_item: { id: 'r-0002', name: 'خبز عربي', unit_of_measure: 'قطعة' },
        quantity_required: 1,
      },
      {
        raw_item: { id: 'r-0003', name: 'صلصة ثوم', unit_of_measure: 'جرام' },
        quantity_required: 30,
      },
      {
        raw_item: { id: 'r-0004', name: 'مخلل', unit_of_measure: 'جرام' },
        quantity_required: 20,
      },
    ],
  },
  {
    sellable_item: sellable('s0000002-0000-4000-8000-000000000002', 'برجر لحم', 'BRG-01'),
    total_cost: 18.75,
    recipe_lines: [
      {
        raw_item: { id: 'r-0005', name: 'قرص لحم', unit_of_measure: 'جرام' },
        quantity_required: 150,
      },
      {
        raw_item: { id: 'r-0006', name: 'خبز برجر', unit_of_measure: 'قطعة' },
        quantity_required: 1,
      },
      {
        raw_item: { id: 'r-0007', name: 'جبنة شيدر', unit_of_measure: 'جرام' },
        quantity_required: 25,
      },
      {
        raw_item: { id: 'r-0008', name: 'خس', unit_of_measure: 'جرام' },
        quantity_required: 15,
      },
    ],
  },
  {
    sellable_item: sellable('s0000003-0000-4000-8000-000000000003', 'فلافل', 'FLF-01'),
    total_cost: 7.0,
    recipe_lines: [
      {
        raw_item: { id: 'r-0009', name: 'حمص', unit_of_measure: 'جرام' },
        quantity_required: 120,
      },
      {
        raw_item: { id: 'r-0010', name: 'بقدونس', unit_of_measure: 'جرام' },
        quantity_required: 20,
      },
      {
        raw_item: { id: 'r-0002', name: 'خبز عربي', unit_of_measure: 'قطعة' },
        quantity_required: 1,
      },
    ],
  },
  {
    sellable_item: sellable('s0000004-0000-4000-8000-000000000004', 'عصير برتقال طازج', 'JUC-01'),
    total_cost: 9.25,
    recipe_lines: [
      {
        raw_item: { id: 'r-0011', name: 'برتقال', unit_of_measure: 'جرام' },
        quantity_required: 400,
      },
      {
        raw_item: { id: 'r-0012', name: 'سكر', unit_of_measure: 'جرام' },
        quantity_required: 15,
      },
    ],
  },
];

export class MockRecipeRepository implements RecipeRepository {
  getRecipes(): Promise<Recipe[]> {
    // A short delay simulates network latency so loading states are exercised.
    return new Promise((resolve) => {
      setTimeout(() => resolve(MOCK_RECIPES), 400);
    });
  }
}
