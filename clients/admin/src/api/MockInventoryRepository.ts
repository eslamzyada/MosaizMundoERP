import type { InventoryRepository } from './InventoryRepository';
import type {
  CreateIngredientPayload,
  InventoryDeficit,
  InventoryStock,
  ReceiveStockPayload,
  UpdateIngredientPayload,
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
}
