import type { InventoryRepository } from './InventoryRepository';
import type {
  CreateIngredientPayload,
  DeleteIngredientResult,
  ExpiringLot,
  StockLot,
  InventoryDeficit,
  InventoryStock,
  ReceiveStockPayload,
  UpdateIngredientPayload,
  WriteOff,
  WriteOffPayload,
} from '../types';

// Mock-first: hardcoded, realistic data. No network calls anywhere in the app.
const MOCK_DEFICITS: InventoryDeficit[] = [
  {
    id: 'a1000000-0000-4000-8000-000000000001',
    organization_id: 'org-00000000-0000-4000-8000-000000000001',
    raw_item_id: 'raw-0000-0000-4000-8000-000000000001',
    missing_quantity: 12,
    recorded_at: '2026-07-11T18:32:00.000Z',
    updated_at: '2026-07-11T18:32:00.000Z',
    raw_inventory_items: {
      id: 'raw-0000-0000-4000-8000-000000000001',
      name: 'Beef Patty',
      unit_of_measure: 'pieces',
    },
  },
  {
    id: 'a1000000-0000-4000-8000-000000000002',
    organization_id: 'org-00000000-0000-4000-8000-000000000001',
    raw_item_id: 'raw-0000-0000-4000-8000-000000000002',
    missing_quantity: 450,
    recorded_at: '2026-07-11T20:05:00.000Z',
    updated_at: '2026-07-11T20:05:00.000Z',
    raw_inventory_items: {
      id: 'raw-0000-0000-4000-8000-000000000002',
      name: 'Mozzarella',
      unit_of_measure: 'grams',
    },
  },
  {
    id: 'a1000000-0000-4000-8000-000000000003',
    organization_id: 'org-00000000-0000-4000-8000-000000000001',
    raw_item_id: 'raw-0000-0000-4000-8000-000000000003',
    missing_quantity: 8,
    recorded_at: '2026-07-12T09:14:00.000Z',
    updated_at: '2026-07-12T09:14:00.000Z',
    raw_inventory_items: {
      id: 'raw-0000-0000-4000-8000-000000000003',
      name: 'Roma Tomato',
      unit_of_measure: 'pieces',
    },
  },
  {
    id: 'a1000000-0000-4000-8000-000000000004',
    organization_id: 'org-00000000-0000-4000-8000-000000000001',
    raw_item_id: 'raw-0000-0000-4000-8000-000000000004',
    missing_quantity: 300,
    recorded_at: '2026-07-12T11:47:00.000Z',
    updated_at: '2026-07-12T11:47:00.000Z',
    raw_inventory_items: {
      id: 'raw-0000-0000-4000-8000-000000000004',
      name: 'Extra Virgin Olive Oil',
      unit_of_measure: 'milliliters',
    },
  },
];

// Mixed states on purpose so every dashboard badge is exercised: healthy, low,
// out of stock, expiring soon, and a non-perishable (null expiry).
const MOCK_STOCK: InventoryStock[] = [
  {
    id: 'raw-0000-0000-4000-8000-000000000001',
    name: 'Beef Patty',
    unit_of_measure: 'pieces',
    reorder_threshold: 20,
    on_hand: 15,
    open_batches: 1,
    earliest_expiry: '2026-07-24T00:00:00.000Z',
    stock_value: 45,
    is_active: true,
  },
  {
    id: 'raw-0000-0000-4000-8000-000000000002',
    name: 'Mozzarella',
    unit_of_measure: 'grams',
    reorder_threshold: 1000,
    on_hand: 2500,
    open_batches: 2,
    earliest_expiry: '2026-07-27T00:00:00.000Z',
    stock_value: 500,
    is_active: true,
  },
  {
    id: 'raw-0000-0000-4000-8000-000000000003',
    name: 'Lentils',
    unit_of_measure: 'grams',
    reorder_threshold: 1000,
    on_hand: 0,
    open_batches: 0,
    earliest_expiry: null,
    stock_value: 0,
    is_active: true,
  },
  {
    id: 'raw-0000-0000-4000-8000-000000000004',
    name: 'Mango',
    unit_of_measure: 'grams',
    reorder_threshold: 1500,
    on_hand: 800,
    open_batches: 1,
    earliest_expiry: '2026-07-19T00:00:00.000Z',
    stock_value: 64,
    is_active: true,
  },
  {
    id: 'raw-0000-0000-4000-8000-000000000005',
    name: 'Water Bottle',
    unit_of_measure: 'pieces',
    reorder_threshold: 24,
    on_hand: 120,
    open_batches: 1,
    earliest_expiry: null,
    stock_value: 420,
    is_active: true,
  },
];

export class MockInventoryRepository implements InventoryRepository {
  getDeficits(): Promise<InventoryDeficit[]> {
    // A short delay simulates network latency so loading states are exercised.
    return new Promise((resolve) => {
      setTimeout(() => resolve(MOCK_DEFICITS), 400);
    });
  }

  getStock(): Promise<InventoryStock[]> {
    return new Promise((resolve) => {
      setTimeout(() => resolve(MOCK_STOCK), 400);
    });
  }

  receiveStock(payload: ReceiveStockPayload): Promise<void> {
    const row = MOCK_STOCK.find((s) => s.id === payload.raw_item_id);
    if (row) {
      row.on_hand += payload.quantity_received;
      row.open_batches += 1;
      row.stock_value += payload.quantity_received * payload.cost_at_purchase;
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(), 150);
    });
  }

  createIngredient(payload: CreateIngredientPayload): Promise<void> {
    MOCK_STOCK.push({
      id: `mock-${Date.now()}`,
      name: payload.name,
      unit_of_measure: payload.unit_of_measure,
      reorder_threshold: payload.reorder_threshold ?? 0,
      on_hand: 0,
      open_batches: 0,
      earliest_expiry: null,
      stock_value: 0,
    is_active: true,
    });
    return new Promise((resolve) => setTimeout(() => resolve(), 150));
  }

  updateIngredient(id: string, payload: UpdateIngredientPayload): Promise<void> {
    const row = MOCK_STOCK.find((s) => s.id === id);
    if (row) {
      if (payload.name !== undefined) row.name = payload.name;
      if (payload.unit_of_measure !== undefined) row.unit_of_measure = payload.unit_of_measure;
      if (payload.reorder_threshold !== undefined) row.reorder_threshold = payload.reorder_threshold;
    }
    return new Promise((resolve) => setTimeout(() => resolve(), 150));
  }

  // ---- Write-offs and expiry (0023) ----------------------------------------

  // Two lots that span the states the panel styles differently: one already
  // past its date (the urgent kind — stock the books still call sellable) and
  // one a few days out.
  getExpiring(days: number): Promise<ExpiringLot[]> {
    const lots: ExpiringLot[] = [
      {
        batch_id: 'mock-lot-expired',
        raw_item_id: MOCK_STOCK[0]?.id ?? 'mock-1',
        item_name: MOCK_STOCK[0]?.name ?? 'دجاج',
        unit_of_measure: MOCK_STOCK[0]?.unit_of_measure ?? 'kg',
        quantity_remaining: 3,
        cost_at_purchase: 90,
        value_at_risk: 270,
        expiry_date: new Date(Date.now() - 2 * 86400000).toISOString(),
        supplier_name: 'مورّد تجريبي',
        already_expired: true,
        days_left: -2,
      },
      {
        batch_id: 'mock-lot-soon',
        raw_item_id: MOCK_STOCK[1]?.id ?? 'mock-2',
        item_name: MOCK_STOCK[1]?.name ?? 'طماطم',
        unit_of_measure: MOCK_STOCK[1]?.unit_of_measure ?? 'kg',
        quantity_remaining: 8,
        cost_at_purchase: 12,
        value_at_risk: 96,
        expiry_date: new Date(Date.now() + 2 * 86400000).toISOString(),
        supplier_name: null,
        already_expired: false,
        days_left: 2,
      },
    ];
    return new Promise((resolve) =>
      setTimeout(() => resolve(lots.filter((l) => l.days_left <= days)), 200),
    );
  }

  createWriteOff(payload: WriteOffPayload): Promise<void> {
    const row = MOCK_STOCK.find((s) => s.id === payload.raw_item_id);
    if (row) {
      row.on_hand = Math.max(0, row.on_hand - payload.quantity);
    }
    return new Promise((resolve) => setTimeout(() => resolve(), 150));
  }

  getWriteOffs(): Promise<WriteOff[]> {
    return new Promise((resolve) => setTimeout(() => resolve([]), 150));
  }

  // Mirrors the real rule: anything holding stock counts as "has history" here,
  // so the UI's two branches are both reachable without a backend.
  deleteIngredient(id: string): Promise<DeleteIngredientResult> {
    const row = MOCK_STOCK.find((s) => s.id === id);
    if (row && row.on_hand > 0) {
      return Promise.resolve({
        outcome: 'has_history',
        references: {
          recipes: 2,
          stock_lots: row.open_batches,
          consumption_records: 14,
          write_offs: 1,
          stocktake_counts: 3,
          purchase_order_lines: 2,
          deficits: 0,
        },
      });
    }
    const i = MOCK_STOCK.findIndex((s) => s.id === id);
    if (i >= 0) MOCK_STOCK.splice(i, 1);
    return Promise.resolve({ outcome: 'deleted' });
  }

  setIngredientActive(id: string, isActive: boolean): Promise<void> {
    const row = MOCK_STOCK.find((s) => s.id === id);
    if (row) row.is_active = isActive;
    return new Promise((resolve) => setTimeout(() => resolve(), 150));
  }

  getItemLots(id: string): Promise<StockLot[]> {
    const row = MOCK_STOCK.find((s) => s.id === id);
    const lots: StockLot[] = row
      ? [
          {
            id: `${id}-lot-1`,
            quantity_received: row.on_hand + 10,
            quantity_remaining: row.on_hand,
            cost_at_purchase: 12.5,
            value_remaining: row.on_hand * 12.5,
            expiry_date: row.earliest_expiry,
            received_at: '2026-07-12T09:00:00.000Z',
            supplier_name: 'مورّد تجريبي',
          },
        ]
      : [];
    return new Promise((resolve) => setTimeout(() => resolve(lots), 200));
  }

  correctLotCost(): Promise<number> {
    return Promise.resolve(12.5);
  }
}
