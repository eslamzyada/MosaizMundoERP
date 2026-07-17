import { apiClient } from './client';
import type { InventoryRepository } from './InventoryRepository';
import type { InventoryDeficit, InventoryStock, ReceiveStockPayload } from '../types';

// Live implementation of InventoryRepository. RLS on the backend scopes the
// result to the authenticated token's organization(s).
export class HttpInventoryRepository implements InventoryRepository {
  async getDeficits(): Promise<InventoryDeficit[]> {
    const { data } = await apiClient.get<InventoryDeficit[]>('/api/inventory/deficits');
    return data;
  }

  async getStock(): Promise<InventoryStock[]> {
    const { data } = await apiClient.get<InventoryStock[]>('/api/inventory/stock');
    return data;
  }

  async receiveStock(payload: ReceiveStockPayload): Promise<void> {
    await apiClient.post('/api/inventory/receive', payload);
  }
}
