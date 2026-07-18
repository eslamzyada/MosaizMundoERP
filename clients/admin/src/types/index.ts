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

/**
 * Aggregated stock on hand for one raw ingredient (GET /api/inventory/stock).
 * Only OPEN lots (quantity_remaining > 0) contribute, so `earliest_expiry` is
 * the soonest expiry of stock you can actually still sell. An ingredient with
 * no open lots is still returned, at zero.
 */
export interface InventoryStock {
  id: string;
  name: string;
  unit_of_measure: string;
  /** Minimum on hand before the item is flagged. 0 disables the alert. */
  reorder_threshold: number;
  on_hand: number;
  open_batches: number;
  earliest_expiry: string | null;
  stock_value: number;
}

/** Payload for recording a new FIFO stock lot (POST /api/inventory/receive). */
export interface ReceiveStockPayload {
  raw_item_id: string;
  quantity_received: number;
  cost_at_purchase: number;
  expiry_date?: string | null;
}

// ---- Identity & membership ---------------------------------------------------

/** Mirrors organization_memberships.role's CHECK constraint. */
export type Role =
  | 'owner'
  | 'regional_manager'
  | 'branch_manager'
  | 'accountant'
  | 'cashier'
  | 'staff';

export const ROLES: Role[] = [
  'owner',
  'regional_manager',
  'branch_manager',
  'accountant',
  'cashier',
  'staff',
];

/** GET /api/me — who the caller is, and what they may do. */
export interface Me {
  user_id: string;
  organization_id: string;
  role: Role;
}

/** GET /api/members — one row of the team roster. */
export interface Member {
  user_id: string;
  organization_id: string;
  email: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  /** The server flags the caller's own row: they may not re-role or deactivate it. */
  is_self: boolean;
}

/** GET /api/members/invitations — a pending (unaccepted, unexpired) invitation. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  created_at: string;
  expires_at: string;
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

// The backend currently emits 'completed' | 'voided'; 'refunded' is a
// forward-looking status the admin UI already renders.
export type OrderStatus = 'completed' | 'voided' | 'refunded';

export interface Order {
  id: string;
  organization_id: string;
  client_offline_id: string;
  status: OrderStatus;
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
