import { apiClient } from './client';
import type { AddRecipeLinePayload, RecipeRepository } from './RecipeRepository';
import type { RawInventoryItem, Recipe } from '../types';

// The backend returns sellable_items with their bill_of_materials (recipe
// lines), each carrying the nested raw_inventory_items. These shapes describe
// that payload so we can map it to the frontend Recipe model.
interface BackendRawItem {
  id: string;
  name: string;
  unit_of_measure: string;
}

interface BackendBomLine {
  id: string;
  raw_item_id: string;
  quantity_required: number;
  unit_cost: number | null;
  line_cost: number | null;
  raw_inventory_items: BackendRawItem;
}

interface BackendSellable {
  id: string;
  organization_id: string;
  name: string;
  sku: string | null;
  price: number;
  created_at: string;
  updated_at: string;
  bill_of_materials: BackendBomLine[];
  total_cost: number;
  uncosted_line_count: number;
}

function mapRecipe(s: BackendSellable): Recipe {
  return {
    sellable_item: {
      id: s.id,
      organization_id: s.organization_id,
      name: s.name,
      sku: s.sku,
      created_at: s.created_at,
      updated_at: s.updated_at,
    },
    recipe_lines: s.bill_of_materials.map((line) => ({
      id: line.id,
      raw_item: {
        id: line.raw_inventory_items.id,
        name: line.raw_inventory_items.name,
        unit_of_measure: line.raw_inventory_items.unit_of_measure,
        // category is a UI-only concept; the DB doesn't track it.
      },
      quantity_required: Number(line.quantity_required),
      // Kept nullable end to end: an ingredient with no stock has no cost, and
      // coercing that to 0 here would quietly understate the dish.
      unit_cost: line.unit_cost === null ? null : Number(line.unit_cost),
      line_cost: line.line_cost === null ? null : Number(line.line_cost),
    })),
    // Food cost, computed by the API from the stock actually on hand.
    total_cost: Number(s.total_cost),
    uncosted_line_count: s.uncosted_line_count,
    price: Number(s.price),
  };
}

export class HttpRecipeRepository implements RecipeRepository {
  async getRecipes(): Promise<Recipe[]> {
    const { data } = await apiClient.get<BackendSellable[]>('/api/recipes');
    return data.map(mapRecipe);
  }

  async getIngredients(): Promise<RawInventoryItem[]> {
    // The raw ingredient catalog for the add-ingredient picker.
    const { data } = await apiClient.get<RawInventoryItem[]>('/api/inventory/items');
    return data;
  }

  async addIngredient(sellableItemId: string, payload: AddRecipeLinePayload): Promise<void> {
    await apiClient.post(`/api/recipes/${sellableItemId}/lines`, payload);
  }

  async updateLine(lineId: string, quantityRequired: number): Promise<void> {
    await apiClient.patch(`/api/recipes/lines/${lineId}`, {
      quantity_required: quantityRequired,
    });
  }

  async removeLine(lineId: string): Promise<void> {
    await apiClient.delete(`/api/recipes/lines/${lineId}`);
  }
}
