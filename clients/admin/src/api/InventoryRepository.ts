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

  /**
   * Removes an ingredient that has never been used. One with history cannot be
   * deleted — the foreign keys refuse it, deliberately — so the result reports
   * `has_history` with what references it, and archiving is the answer instead.
   */
  deleteIngredient(id: string): Promise<DeleteIngredientResult>;

  /** Retires or restores an ingredient: hidden from pickers, history intact. */
  setIngredientActive(id: string, isActive: boolean): Promise<void>;

  /** The lots behind one ingredient — a cost belongs to a lot, not an item. */
  getItemLots(id: string): Promise<StockLot[]>;

  /** Corrects a cost keyed in wrongly at receiving. Returns the previous value. */
  correctLotCost(lotId: string, cost: number): Promise<number>;
}
