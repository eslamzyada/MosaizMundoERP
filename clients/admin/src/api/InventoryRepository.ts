import type { InventoryDeficit, InventoryStock, ReceiveStockPayload } from '../types';

// The data-access boundary for the Inventory context. The UI depends only on
// this interface, so a MockInventoryRepository can be swapped for an
// HttpInventoryRepository without touching any component.
export interface InventoryRepository {
  /** The deficit ledger: stock sold beyond what was recorded. */
  getDeficits(): Promise<InventoryDeficit[]>;

  /** Stock on hand per ingredient, aggregated across open FIFO lots. */
  getStock(): Promise<InventoryStock[]>;

  /** Records a new FIFO stock lot against an existing ingredient. */
  receiveStock(payload: ReceiveStockPayload): Promise<void>;
}
