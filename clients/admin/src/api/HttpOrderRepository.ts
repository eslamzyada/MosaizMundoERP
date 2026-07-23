import { apiClient } from './client';
import type { OrderRepository } from './OrderRepository';
import type { VoidReasonCode } from '../lib/voidReasons';
import type { Order } from '../types';

// Live implementation of OrderRepository. RLS on the backend scopes the result
// to the authenticated token's organization(s).
export class HttpOrderRepository implements OrderRepository {
  async getOrders(): Promise<Order[]> {
    const { data } = await apiClient.get<Order[]>('/api/pos/orders');
    return data;
  }

  async voidOrder(
    orderId: string,
    restoreStock: boolean,
    reason: VoidReasonCode,
    note: string,
  ): Promise<void> {
    await apiClient.post(`/api/pos/orders/${orderId}/void`, {
      restore_stock: restoreStock,
      void_reason: reason,
      // Omitted rather than sent empty: the note column is null when there
      // isn't one, and '' would have to be special-cased in every reader.
      ...(note !== '' ? { void_note: note } : {}),
    });
  }
}
