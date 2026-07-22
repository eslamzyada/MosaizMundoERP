import type {
  CreatePurchaseOrderPayload,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  PurchaseReceipt,
  ReorderSuggestion,
} from '../types';

// Data-access boundary for purchase orders. Reads are open to every member;
// everything that commits money is admin-only, enforced by the API and the
// 0021 policies behind it.
export interface PurchaseOrderRepository {
  list(status?: PurchaseOrderStatus): Promise<PurchaseOrderSummary[]>;
  /** What has fallen below its minimum, net of anything already inbound. */
  suggestions(): Promise<ReorderSuggestion[]>;
  get(id: string): Promise<PurchaseOrder>;
  create(payload: CreatePurchaseOrderPayload): Promise<{ id: string }>;
  /** draft -> placed. Only then can a delivery be recorded. */
  place(id: string): Promise<void>;
  /** Records a delivery, creating the stock lots. */
  receive(id: string, receipts: PurchaseReceipt[]): Promise<void>;
  cancel(id: string): Promise<void>;
}
