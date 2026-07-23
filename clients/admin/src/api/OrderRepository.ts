import type { VoidReasonCode } from '../lib/voidReasons';
import type { Order } from '../types';

// Data-access boundary for the Sales/Orders context. Components depend on this
// interface only, so MockOrderRepository can later be swapped for an
// HttpOrderRepository (GET /api/pos/orders) without any UI changes.
export interface OrderRepository {
  getOrders(): Promise<Order[]>;
  /**
   * Voids a completed order.
   *
   * `restoreStock` is the caller's answer to "was the food made?" — true returns
   * the consumed ingredients to their lots, false leaves them deducted. There is
   * no default on purpose.
   *
   * `reason` is why (0022), from the fixed vocabulary; the database refuses a
   * void without one. `note` is free context, and mandatory only for 'other' —
   * pass '' when there is none.
   */
  voidOrder(
    orderId: string,
    restoreStock: boolean,
    reason: VoidReasonCode,
    note: string,
  ): Promise<void>;
}
