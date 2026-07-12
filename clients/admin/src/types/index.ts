// TypeScript models mirroring the API gateway's JSON responses.
// Decimal columns are serialized as JS numbers by the backend (the res.json
// Decimal interceptor), and timestamps as ISO 8601 strings.

export interface SellableItem {
  id: string;
  organization_id: string;
  name: string;
  sku: string | null;
  created_at: string;
  updated_at: string;
}

/** The nested ingredient shape returned with each deficit (selected fields). */
export interface RawInventoryItemRef {
  id: string;
  name: string;
  unit_of_measure: string;
}

export interface InventoryDeficit {
  id: string;
  organization_id: string;
  raw_item_id: string;
  missing_quantity: number;
  recorded_at: string;
  updated_at: string;
  raw_inventory_items: RawInventoryItemRef;
}

export interface OrderItem {
  id: string;
  order_id: string;
  organization_id: string;
  sellable_item_id: string;
  quantity: number;
  unit_price: number;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  organization_id: string;
  client_offline_id: string;
  status: 'completed' | 'voided';
  total_amount: number;
  created_at: string;
  updated_at: string;
  order_items: OrderItem[];
}

// ---- Bill of Materials (recipes) -------------------------------------------

/** How a raw ingredient is sourced. */
export type IngredientCategory = 'purchased' | 'intermediate';

export interface RawInventoryItem {
  id: string;
  name: string;
  unit_of_measure: string;
  // 'purchased' = bought as-is (مشتريات); 'intermediate' = made in-house (وسيط).
  category?: IngredientCategory;
}

/** One ingredient line of a recipe: how much of a raw item it consumes. */
export interface RecipeLine {
  raw_item: RawInventoryItem;
  quantity_required: number;
}

/** A sellable item and the raw ingredients it is built from. */
export interface Recipe {
  sellable_item: SellableItem;
  recipe_lines: RecipeLine[];
  total_cost: number;
}
