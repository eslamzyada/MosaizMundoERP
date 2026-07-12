import type { Order } from '../types';

// Data-access boundary for the Sales/Orders context. Components depend on this
// interface only, so MockOrderRepository can later be swapped for an
// HttpOrderRepository (GET /api/pos/orders) without any UI changes.
export interface OrderRepository {
  getOrders(): Promise<Order[]>;
}
