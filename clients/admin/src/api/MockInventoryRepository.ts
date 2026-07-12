import type { InventoryRepository } from './InventoryRepository';
import type { InventoryDeficit } from '../types';

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

export class MockInventoryRepository implements InventoryRepository {
  getDeficits(): Promise<InventoryDeficit[]> {
    // A short delay simulates network latency so loading states are exercised.
    return new Promise((resolve) => {
      setTimeout(() => resolve(MOCK_DEFICITS), 400);
    });
  }
}
