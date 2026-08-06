import { apiClient } from './client';

/**
 * The staff side of the shopfront (0040).
 *
 * Note there is no `create` and no way to change a line or a total. What a
 * customer asked for is what a customer asked for; staff accept it or turn it
 * down. Editing somebody else's order into something they did not request is
 * not a feature this needs.
 */

export type PublicOrderStatus = 'pending' | 'accepted' | 'rejected' | 'fulfilled' | 'cancelled';

export interface PublicOrderLine {
  item_name: string;
  quantity: number;
  unit_price: number;
}

export interface PublicOrder {
  id: string;
  customer_name: string;
  customer_phone: string;
  note: string | null;
  status: PublicOrderStatus;
  quoted_total: number;
  created_at: string;
  decided_at: string | null;
  rejection_reason: string | null;
  accepted_order_id: string | null;
  lines: PublicOrderLine[];
}

export interface Storefront {
  organization_id: string;
  slug: string;
  display_name: string;
  greeting: string | null;
  is_accepting: boolean;
}

export const publicOrderRepository = {
  async queue(status: 'pending' | 'all' = 'pending'): Promise<PublicOrder[]> {
    const { data } = await apiClient.get<PublicOrder[]>('/api/public-orders', {
      params: { status },
    });
    return data;
  },

  /** Runs the till's own checkout under the caller's identity. */
  async accept(id: string): Promise<string> {
    const { data } = await apiClient.post<{ order_id: string }>(`/api/public-orders/${id}/accept`);
    return data.order_id;
  },

  async reject(id: string, reason: string): Promise<void> {
    await apiClient.post(`/api/public-orders/${id}/reject`, { reason });
  },

  async storefront(): Promise<Storefront | null> {
    const { data } = await apiClient.get<Storefront | null>('/api/public-orders/storefront');
    return data;
  },

  async saveStorefront(input: Partial<Storefront>): Promise<Storefront> {
    const { data } = await apiClient.put<Storefront>('/api/public-orders/storefront', input);
    return data;
  },
};
