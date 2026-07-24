import type {
  CreateIngredientPayload,
  ExpiringLot,
  InventoryDeficit,
  InventoryStock,
  ReceiveStockPayload,
  UpdateIngredientPayload,
  WriteOff,
  WriteOffPayload,
} from '../types';

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

  /** Creates a raw ingredient. Admin-only (server-enforced). */
  createIngredient(payload: CreateIngredientPayload): Promise<void>;

  /** Renames / re-units / re-thresholds an ingredient. Admin-only. */
  updateIngredient(id: string, payload: UpdateIngredientPayload): Promise<void>;

  /**
   * Lots at or past their expiry date within `days`, soonest first. The
   * preventive half of write-offs: seeing what is about to turn is how you
   * avoid having to discard it.
   */
  getExpiring(days: number): Promise<ExpiringLot[]>;

  /** Discards stock outside a sale, with a reason (0023). Admin-only. */
  createWriteOff(payload: WriteOffPayload): Promise<void>;

  /** The log of what has been discarded, newest first. */
  getWriteOffs(): Promise<WriteOff[]>;
}
