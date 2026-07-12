import type { Recipe } from '../types';

// Data-access boundary for the Bill of Materials context. Components depend on
// this interface only, so MockRecipeRepository can later be swapped for an
// HttpRecipeRepository without any UI changes.
export interface RecipeRepository {
  getRecipes(): Promise<Recipe[]>;
}
