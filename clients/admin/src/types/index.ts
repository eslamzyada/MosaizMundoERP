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

/** A menu item as returned by /api/catalog/items — includes the (server-authoritative) price. */
export interface CatalogItemBase {
  id: string;
  organization_id: string;
  name: string;
  sku: string | null;
  price: number;
  created_at: string;
  updated_at: string;
}

/**
 * A menu item as LISTED, which also carries what it costs to make — pricing a
 * dish without that is guesswork. Create/update return `CatalogItemBase`: those
 * endpoints answer with the stored row and do not compute cost.
 *
 * Three states, and none of them is "costs nothing":
 *   recipe_line_count === 0   → no recipe; the cost is unknown
 *   uncosted_line_count > 0   → partly priced; total_cost is a floor
 *   otherwise                 → total_cost is the real food cost
 */
export interface CatalogItem extends CatalogItemBase {
  total_cost: number;
  uncosted_line_count: number;
  recipe_line_count: number;
}

export interface CreateItemPayload {
  name: string;
  price: number;
  sku?: string | null;
}

export interface UpdateItemPayload {
  name?: string;
  price?: number;
  sku?: string | null;
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
  /** Who supplied it, when known. Optional by design — see migration 0020. */
  supplier_id?: string | null;
}

/** Payload for creating a raw ingredient (POST /api/inventory/items). */
export interface CreateIngredientPayload {
  name: string;
  unit_of_measure: string;
  reorder_threshold?: number;
}

/** Payload for editing a raw ingredient (PATCH /api/inventory/items/:id). */
export interface UpdateIngredientPayload {
  name?: string;
  unit_of_measure?: string;
  reorder_threshold?: number;
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

// Mirrors the database CHECK (orders_status_check): 'completed' | 'voided'.
// 'refunded' was rendered by the UI but the DB rejects it (analysis F-12) — a
// refund flow must add the status via migration before the type can grow.
export type OrderStatus = 'completed' | 'voided';

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
  /** The bill_of_materials row id — how a line is addressed for edit/remove. */
  id: string;
  raw_item: RawInventoryItem;
  quantity_required: number;
  /**
   * Weighted-average cost of one unit of this ingredient, across the lots
   * actually in stock. `null` when there is no stock to price it from — which
   * is different from free, and must never be rendered as 0.
   */
  unit_cost: number | null;
  /** unit_cost x quantity_required, or null when the ingredient is unpriced. */
  line_cost: number | null;
}

/** A sellable item and the raw ingredients it is built from. */
export interface Recipe {
  sellable_item: SellableItem;
  recipe_lines: RecipeLine[];
  /**
   * Food cost of the lines that could be priced. When `uncosted_line_count` is
   * above zero this is a FLOOR, not the real cost — the UI must say so rather
   * than presenting it as a finished figure.
   */
  total_cost: number;
  uncosted_line_count: number;
  /** Menu price, so cost can be shown as a percentage of it. 0 = unpriced. */
  price: number;
}

/**
 * Revenue against the cost recorded at each sale (migration 0015), so the
 * figures are history rather than a re-estimate from today's stock prices.
 *
 * `margin_pct` is computed over `costed_revenue` ONLY. Read it together with
 * `coverage_pct`: at 60% coverage the margin describes 60% of the takings, and
 * the rest is revenue whose cost is genuinely unknown. It is null when there is
 * no costed revenue to divide by — no margin is invented.
 */
export interface ProfitBucket {
  revenue: number;
  costed_revenue: number;
  cogs: number;
  gross_profit: number;
  margin_pct: number | null;
  uncosted_revenue: number;
  uncosted_line_count: number;
  coverage_pct: number | null;
}

export interface ProfitDay extends ProfitBucket {
  /** Calendar day, YYYY-MM-DD. */
  day: string;
}

export interface ProfitItem extends ProfitBucket {
  id: string;
  name: string;
  sku: string | null;
  units_sold: number;
}

/**
 * Why some revenue could not be costed, and what would fix it.
 *
 * The blocker is read from CURRENT state, not from history: the useful question
 * is not "what went wrong then" but "what is still stopping this dish from being
 * costed". `already_resolved` means the block was fixed after those sales — the
 * revenue stays uncosted forever, but future sales will be fine and there is
 * nothing to act on.
 */
export interface CoverageGap {
  id: string;
  name: string;
  sku: string | null;
  uncosted_line_count: number;
  uncosted_revenue: number;
  blocking_ingredients: Array<{ id: string; name: string; unit_of_measure: string }>;
  reason: 'no_recipe' | 'unstocked_ingredients' | 'already_resolved';
}

export interface ProfitabilityReport {
  days: number;
  summary: ProfitBucket;
  by_day: ProfitDay[];
  by_item: ProfitItem[];
  coverage_gaps: CoverageGap[];
}

// ---- Stocktakes (counting the shelf) ---------------------------------------

/** draft = being counted · posted = applied to stock · cancelled = abandoned. */
export type StocktakeStatus = 'draft' | 'posted' | 'cancelled';

/** One ingredient on a count sheet. `variance` is generated: counted - expected. */
export interface StocktakeItem {
  id: string;
  raw_item_id: string;
  name: string;
  unit_of_measure: string;
  /** What the books said when the count was opened — the baseline for variance. */
  expected_quantity: number;
  counted_quantity: number;
  variance: number;
}

export interface Stocktake {
  id: string;
  status: StocktakeStatus;
  created_at: string;
  updated_at: string;
  items: StocktakeItem[];
}

/** A row of the stocktake history list. */
export interface StocktakeSummary {
  id: string;
  status: StocktakeStatus;
  created_at: string;
  updated_at: string;
  item_count: number;
  variance_count: number;
}

// ---- Suppliers --------------------------------------------------------------

export interface Supplier {
  id: string;
  organization_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  notes: string | null;
  /** Retired suppliers stay on past lots; they are only hidden from pickers. */
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSupplierPayload {
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface UpdateSupplierPayload {
  name?: string;
  contact_name?: string | null;
  phone?: string | null;
  notes?: string | null;
  is_active?: boolean;
}

/**
 * What one supplier has charged for one ingredient.
 *
 * `previous_cost` is null on a first delivery — there is nothing to compare to,
 * and showing a movement would be inventing one.
 */
export interface SupplierPriceRow {
  raw_item_id: string;
  raw_item_name: string;
  unit_of_measure: string;
  supplier_id: string;
  supplier_name: string;
  supplier_is_active: boolean;
  deliveries: number;
  last_delivered_at: string;
  min_cost: number;
  max_cost: number;
  latest_cost: number;
  previous_cost: number | null;
  total_spend: number;
}

// ---- Purchase orders --------------------------------------------------------

/** draft = not yet a commitment · placed = outstanding · received = fully delivered. */
export type PurchaseOrderStatus = 'draft' | 'placed' | 'received' | 'cancelled';

export interface PurchaseOrderLine {
  id: string;
  raw_item_id: string;
  raw_item_name: string;
  unit_of_measure: string;
  quantity_ordered: number;
  quantity_received: number;
  /** ordered − received. Negative means the supplier over-delivered. */
  quantity_outstanding: number;
  unit_price: number;
}

export interface PurchaseOrder {
  id: string;
  status: PurchaseOrderStatus;
  supplier_id: string;
  suppliers: { id: string; name: string };
  expected_at: string | null;
  placed_at: string | null;
  notes: string | null;
  created_at: string;
  lines: PurchaseOrderLine[];
}

/** A row of the order list, with its outstanding position precomputed. */
export interface PurchaseOrderSummary {
  id: string;
  status: PurchaseOrderStatus;
  supplier_id: string;
  supplier_name: string;
  expected_at: string | null;
  placed_at: string | null;
  created_at: string;
  line_count: number;
  outstanding_lines: number;
  order_value: number;
}

export interface CreatePurchaseOrderPayload {
  supplier_id: string;
  expected_at?: string | null;
  notes?: string | null;
  lines: Array<{ raw_item_id: string; quantity_ordered: number; unit_price: number }>;
}

/** One line of a delivery. `unit_cost` overrides the agreed price when the invoice differs. */
export interface PurchaseReceipt {
  line_id: string;
  quantity: number;
  unit_cost?: number | null;
  expiry_date?: string | null;
}
