import { apiClient } from './client';
import type { PurchaseOrderRepository } from './PurchaseOrderRepository';
import type {
  CreatePurchaseOrderPayload,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  PurchaseReceipt,
} from '../types';

export class HttpPurchaseOrderRepository implements PurchaseOrderRepository {
  async list(status?: PurchaseOrderStatus): Promise<PurchaseOrderSummary[]> {
    const { data } = await apiClient.get<PurchaseOrderSummary[]>('/api/purchase-orders', {
      params: status ? { status } : undefined,
    });
    return data;
  }

  async get(id: string): Promise<PurchaseOrder> {
    const { data } = await apiClient.get<PurchaseOrder>(`/api/purchase-orders/${id}`);
    return data;
  }

  async create(payload: CreatePurchaseOrderPayload): Promise<{ id: string }> {
    const { data } = await apiClient.post<{ id: string }>('/api/purchase-orders', payload);
    return data;
  }

  async place(id: string): Promise<void> {
    await apiClient.post(`/api/purchase-orders/${id}/place`, {});
  }

  async receive(id: string, receipts: PurchaseReceipt[]): Promise<void> {
    await apiClient.post(`/api/purchase-orders/${id}/receive`, { receipts });
  }

  async cancel(id: string): Promise<void> {
    await apiClient.post(`/api/purchase-orders/${id}/cancel`, {});
  }
}
