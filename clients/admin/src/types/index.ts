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
  /** False for a retired ingredient (0024). Kept listed while it still holds stock. */
  is_active: boolean;
}

/** Payload for recording a new FIFO stock lot (POST /api/inventory/receive). */
export interface ReceiveStockPayload {
  raw_item_id: string;
  quantity_received: number;
  /** Cost of ONE unit_of_measure. Send this OR total_cost, never both. */
  cost_at_purchase?: number;
  expiry_date?: string | null;
  /** Who supplied it, when known. Optional by design — see migration 0020. */
  supplier_id?: string | null;
  /** The invoice total. Send this OR cost_at_purchase, never both. */
  total_cost?: number;
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
  | 'waiter'
  | 'kitchen'
  | 'staff';

/** Ordered as an org chart reads, not alphabetically. */
export const ROLES: Role[] = [
  'owner',
  'regional_manager',
  'branch_manager',
  'accountant',
  'cashier',
  'waiter',
  'kitchen',
  'staff',
];

/** GET /api/me — who the caller is, and what they may do. */
export interface Me {
  user_id: string;
  organization_id: string;
  role: Role;
  /**
   * The capabilities this RESTAURANT runs (0037) — a different question from
   * what this ROLE may do. The sidebar is the intersection of the two.
   *
   * Optional so that a client built against an older API still renders: an
   * absent list means "no opinion", which `navFor` reads as everything on.
   */
  modules?: string[];
  /**
   * What the restaurant pays for (0044). Distinct from `modules`, which is
   * what it currently RUNS — the plan is a ceiling on that, not the same fact.
   *
   * Optional for the same reason as above: an older API omits it, and a screen
   * that cannot name the plan should say nothing rather than guess a tier.
   */
  plan?: string;
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
  /**
   * When the kitchen was told to make it, or null while it is still on the tab.
   * A line with no fired_at carries no cost yet — the 0029 CHECK enforces that.
   */
  fired_at: string | null;
  /** A line-level instruction: "بدون بصل". */
  note: string | null;
  /**
   * The dish, joined by the orders endpoint.
   *
   * These last three fields were being RETURNED by the API and were missing
   * from this type, so every screen that wanted a dish name had to reach past
   * the compiler to get one. That gap is how a status the UI did not know about
   * blanked the dashboard; it is corrected here rather than worked around.
   */
  sellable_items?: { name: string; sku: string | null };
}

// Mirrors the database CHECK (orders_status_check): 'completed' | 'voided'.
// 'refunded' was rendered by the UI but the DB rejects it (analysis F-12) — a
// refund flow must add the status via migration before the type can grow.
/**
 * 'open' is a tab a table is still adding to (migration 0029). It was missing
 * here long after the database could produce it, and because API responses are
 * CAST to these types rather than validated, the compiler happily checked every
 * status lookup against a union that no longer matched reality.
 */
export type OrderStatus = 'open' | 'completed' | 'voided';

export interface Order {
  id: string;
  organization_id: string;
  client_offline_id: string;
  status: OrderStatus;
  total_amount: number;
  created_at: string;
  updated_at: string;
  order_items: OrderItem[];
  /** What the tab is called on the floor — usually a table. */
  note: string | null;
  /** Who served it (0026), or null for sales that predate attribution. */
  served_by: string | null;
  // Void metadata (0018, 0022). All null unless status is 'voided' — the
  // database enforces that a voided order has a reason and nothing else does.
  voided_at: string | null;
  stock_restored: boolean | null;
  void_reason: string | null;
  void_note: string | null;
}

// ---- Ingredient lifecycle (0024) -------------------------------------------

/** One stock lot behind an ingredient — where a cost actually lives. */
export interface StockLot {
  id: string;
  quantity_received: number;
  quantity_remaining: number;
  cost_at_purchase: number;
  /** What the supplier's invoice said this delivery cost. Null if never recorded. */
  total_cost: number | null;
  /** quantity_received x rate — differs from total_cost by the rate's rounding. */
  implied_total: number;
  value_remaining: number;
  expiry_date: string | null;
  received_at: string;
  supplier_name: string | null;
}

/** What stopped an ingredient being deleted, so the refusal can be explained. */
export interface IngredientReferences {
  recipes: number;
  stock_lots: number;
  consumption_records: number;
  write_offs: number;
  stocktake_counts: number;
  purchase_order_lines: number;
  deficits: number;
}

/** Outcome of asking to remove an ingredient. */
export type DeleteIngredientResult =
  | { outcome: 'deleted' }
  | { outcome: 'has_history'; references: IngredientReferences };

// ---- Stock write-offs (0023) -----------------------------------------------

/** A lot at or near its expiry date, with what is still on the shelf at risk. */
export interface ExpiringLot {
  batch_id: string;
  raw_item_id: string;
  item_name: string;
  unit_of_measure: string;
  quantity_remaining: number;
  cost_at_purchase: number;
  /** Only what remains: stock already sold is not a future loss. */
  value_at_risk: number;
  expiry_date: string;
  supplier_name: string | null;
  already_expired: boolean;
  /** Negative once expired — how long it has been sitting there past its date. */
  days_left: number;
}

export interface WriteOffPayload {
  raw_item_id: string;
  quantity: number;
  reason: string;
  note?: string;
  /** Naming a lot draws from that lot alone; omitting it draws FIFO. */
  batch_id?: string;
}

export interface WriteOff {
  id: string;
  raw_item_id: string;
  quantity_requested: number;
  quantity_written_off: number;
  /** The part the books did not have — also recorded as an inventory deficit. */
  quantity_short: number;
  total_cost: number;
  reason: string;
  note: string | null;
  created_at: string;
  raw_inventory_items: { name: string; unit_of_measure: string };
  users: { email: string } | null;
}

// ---- Report windows --------------------------------------------------------

/**
 * The period a report covers. A rolling window answers "how are we doing now";
 * an explicit one answers "how did last month go" — and only the second can be
 * quoted, because it does not slide forward every time the page is reloaded.
 */
export type ReportWindow =
  | { kind: 'rolling'; days: number }
  | { kind: 'range'; from: string; to: string };


// ---- Inventory as an asset -------------------------------------------------

export interface AssetItem {
  id: string;
  name: string;
  unit_of_measure: string;
  is_active: boolean;
  on_hand: number;
  /** Money sitting on the shelf as this ingredient. */
  capital: number;
  capital_share_pct: number | null;
  /** Age of the oldest open lot — how long the earliest money has been stuck. */
  days_held: number | null;
  consumed_quantity: number;
  consumed_cost: number;
  /** Null when nothing moved: a gap, not an infinity. */
  days_of_cover: number | null;
  is_dead_stock: boolean;
}

export interface InventoryAssetsReport extends ReportPeriod {
  summary: {
    capital_tied_up: number;
    stock_consumed_cost: number;
    /** Null when nothing moved — the division has no denominator. */
    turnover: number | null;
    dead_capital: number;
    dead_capital_pct: number | null;
    /** False means the figures above are ABSENT, not zero. */
    has_usage_data: boolean;
    window_days: number;
  };
  by_item: AssetItem[];
}


// ---- Employee performance (0026) -------------------------------------------

export interface EmployeeRow {
  user_id: string;
  email: string | null;
  role: string | null;
  /** False once they have left; their record survives them. */
  is_active: boolean | null;
  orders_served: number;
  revenue: number;
  average_order_value: number | null;
  /** THEIR sales that were voided — not voids they authorised. */
  voided_orders: number;
  voided_value: number;
  void_rate_pct: number | null;
  revenue_share_pct: number | null;
}

export interface EmployeeReport extends ReportPeriod {
  team: {
    headcount: number;
    orders_served: number;
    revenue: number;
    average_orders_per_person: number | null;
    average_revenue_per_person: number | null;
    average_order_value: number | null;
    void_rate_pct: number | null;
  };
  /** Sales with no recorded server — orders that predate attribution. */
  unattributed: { orders_served: number; revenue: number; present: boolean };
  employees: EmployeeRow[];
}


// ---- Employee ratings (0027) -----------------------------------------------

export interface EmployeeRating {
  id: string;
  employee_id: string;
  employee_email: string;
  period_month: string;
  /** 1..5. A small scale on purpose — nobody can defend a 6 versus a 7. */
  score: number;
  note: string | null;
  rated_by: string | null;
  rated_by_email: string | null;
  updated_at: string;
  /** False once the month has closed; the server decides, not the UI. */
  is_editable: boolean;
}

export interface RatingsResponse {
  current_month: string;
  ratings: EmployeeRating[];
}

export interface RatingPayload {
  employee_id: string;
  period_month: string;
  score: number;
  note?: string;
}

// ---- Waste report (0023) ---------------------------------------------------

export interface WasteReasonRow {
  reason: string;
  /** False for staff meals and 'other': real cost, but not food destroyed. */
  is_waste: boolean;
  write_off_count: number;
  quantity: number;
  cost: number;
  /** Write-offs here that exceeded recorded stock — the books were already wrong. */
  exceeded_recorded_stock_count: number;
}

export interface WasteItemRow {
  id: string;
  name: string;
  unit_of_measure: string;
  write_off_count: number;
  quantity: number;
  cost: number;
}

export interface WasteSupplierRow {
  id: string | null;
  name: string | null;
  quantity: number;
  cost: number;
}

export interface ReportPeriod {
  /** Inclusive calendar dates the figures cover. */
  from: string;
  to: string;
  /** The rolling length asked for, or null when an explicit range was given. */
  days: number | null;
}

export interface WasteReport extends ReportPeriod {
  summary: {
    write_off_cost: number;
    waste_cost: number;
    staff_meal_cost: number;
    other_cost: number;
    cogs: number;
    /** Waste over total food cost (waste + COGS). Null when nothing moved. */
    waste_share_pct: number | null;
    write_off_count: number;
    exceeded_recorded_stock_count: number;
  };
  by_reason: WasteReasonRow[];
  by_item: WasteItemRow[];
  by_supplier: WasteSupplierRow[];
}

// ---- Voids report (0022) ---------------------------------------------------

export interface VoidReasonRow {
  reason: string;
  void_count: number;
  /** Order value that will not be collected — often re-rung a moment later. */
  lost_revenue: number;
  /** Voids that put the ingredients back: the cheap kind. */
  stock_returned_count: number;
  /** COGS of food that was made and then written off. The money truly gone. */
  ingredient_cost_lost: number;
  /** How many un-restored voids the figure above cannot fully account for. */
  uncosted_void_count: number;
}

export interface VoidActorRow {
  user_id: string | null;
  email: string | null;
  void_count: number;
}

export interface VoidsReport extends ReportPeriod {
  summary: Omit<VoidReasonRow, 'reason'>;
  by_reason: VoidReasonRow[];
  by_actor: VoidActorRow[];
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

export interface ProfitabilityReport extends ReportPeriod {
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

/**
 * An ingredient that has fallen below its reorder threshold.
 *
 * `shortfall` already nets off `quantity_on_order`, so acting on every
 * suggestion cannot double-order stock that is already inbound.
 *
 * The suggested supplier is the cheapest ACTIVE one by their most recent price
 * for this exact ingredient. It is null when nothing has ever been bought from
 * anyone — there is no evidence to choose on, so the UI asks instead.
 */
export interface ReorderSuggestion {
  raw_item_id: string;
  name: string;
  unit_of_measure: string;
  quantity_on_hand: number;
  reorder_threshold: number;
  quantity_on_order: number;
  shortfall: number;
  suggested_supplier_id: string | null;
  suggested_supplier_name: string | null;
  suggested_unit_price: number | null;
}

// --- Printers (0031) --------------------------------------------------------

/** What a printer is FOR — the only thing routing has to decide. */
export type PrinterRole = 'kitchen' | 'receipt';

export interface Printer {
  id: string;
  organization_id: string;
  name: string;
  role: PrinterRole;
  /** IP or hostname on the restaurant's LAN. The till connects; the API never does. */
  host: string;
  port: number;
  /**
   * At most one ACTIVE printer per role. A printer is replaced by deactivating
   * the old row and adding a new one, so what was replaced stays visible.
   */
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreatePrinterPayload {
  name: string;
  role: PrinterRole;
  host: string;
  port?: number;
}

/** role is absent on purpose: changing it would silently redirect every ticket. */
export interface UpdatePrinterPayload {
  name?: string;
  host?: string;
  port?: number;
  is_active?: boolean;
}


// ---- Trends: everything on one timeline (Phase D) ---------------------------

export interface TrendPoint {
  /** The bucket's first calendar day, YYYY-MM-DD, in the restaurant's own zone. */
  bucket_start: string;
  revenue: number;
  costed_revenue: number;
  cogs: number;
  /** Over COSTED revenue only, so a partly costed period is not flattered. */
  gross_profit: number;
  order_count: number;
  /** Food destroyed: expired, spoiled, damaged, prep error. */
  waste_cost: number;
  /** Everything written off, including staff meals — real cost, not all waste. */
  write_off_cost: number;
  /** Committed spend, dated when the order was placed. */
  purchasing_cost: number;
}

export type TrendBucket = 'day' | 'week' | 'month';

export interface TrendsReport extends ReportPeriod {
  bucket: TrendBucket;
  summary: {
    revenue: number;
    costed_revenue: number;
    cogs: number;
    gross_profit: number;
    margin_pct: number | null;
    coverage_pct: number | null;
    order_count: number;
    /** Null when nothing sold — there was no average, and 0 would be a lie. */
    average_ticket: number | null;
    waste_cost: number;
    write_off_cost: number;
    waste_share_pct: number | null;
    purchasing_cost: number;
    bucket_count: number;
  };
  points: TrendPoint[];
}


// ---- Purchasing: what was bought, and what has not arrived ------------------

export interface PurchasingSupplierRow {
  id: string;
  name: string;
  is_active: boolean;
  order_count: number;
  committed: number;
  received: number;
  outstanding: number;
}

export interface PurchasingStatusRow {
  status: string;
  order_count: number;
  committed: number;
}

export interface PurchasingItemRow {
  id: string;
  name: string;
  unit_of_measure: string;
  quantity_ordered: number;
  committed: number;
  /** The most recent price agreed, not an average — it is what the next one costs. */
  last_unit_price: number;
}

export interface PurchasingReport extends ReportPeriod {
  summary: {
    committed: number;
    received: number;
    outstanding: number;
    fulfilment_pct: number | null;
    order_count: number;
    supplier_count: number;
    /** Every undelivered order, whenever it was placed — NOT window-scoped. */
    open_orders: {
      order_count: number;
      outstanding: number;
      oldest_placed_at: string | null;
    };
  };
  by_supplier: PurchasingSupplierRow[];
  by_status: PurchasingStatusRow[];
  by_item: PurchasingItemRow[];
}
