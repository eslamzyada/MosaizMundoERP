import type { Recipe, RawInventoryItem } from '../types';

export interface AddRecipeLinePayload {
  raw_item_id: string;
  quantity_required: number;
}

// Data-access boundary for the Bill of Materials context. Components depend on
// this interface only, so the mock and HTTP implementations are interchangeable.
export interface RecipeRepository {
  getRecipes(): Promise<Recipe[]>;
  /** The catalog of raw ingredients available to add to a recipe. */
  getIngredients(): Promise<RawInventoryItem[]>;
  /** Adds one ingredient line to a sellable item's recipe. */
  addIngredient(sellableItemId: string, payload: AddRecipeLinePayload): Promise<void>;
}
