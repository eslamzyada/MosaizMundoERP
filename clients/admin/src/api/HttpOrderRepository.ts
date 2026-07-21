import { apiClient } from './client';
import type { OrderRepository } from './OrderRepository';
import type { Order } from '../types';

// Live implementation of OrderRepository. RLS on the backend scopes the result
// to the authenticated token's organization(s).
export class HttpOrderRepository implements OrderRepository {
  async getOrders(): Promise<Order[]> {
    const { data } = await apiClient.get<Order[]>('/api/pos/orders');
    return data;
  }

  async voidOrder(orderId: string, restoreStock: boolean): Promise<void> {
    await apiClient.post(`/api/pos/orders/${orderId}/void`, { restore_stock: restoreStock });
  }
}
