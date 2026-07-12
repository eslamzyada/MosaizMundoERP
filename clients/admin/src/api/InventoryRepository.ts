import type { InventoryDeficit } from '../types';

// The data-access boundary for the Inventory context. The UI depends only on
// this interface, so a MockInventoryRepository (now) can be swapped for an
// HttpInventoryRepository (later) without touching any component.
export interface InventoryRepository {
  getDeficits(): Promise<InventoryDeficit[]>;
}
