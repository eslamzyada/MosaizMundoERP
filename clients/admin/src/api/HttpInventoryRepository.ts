import { apiClient } from './client';
import type { InventoryRepository } from './InventoryRepository';
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

  async createIngredient(payload: CreateIngredientPayload): Promise<void> {
    await apiClient.post('/api/inventory/items', payload);
  }

  async updateIngredient(id: string, payload: UpdateIngredientPayload): Promise<void> {
    await apiClient.patch(`/api/inventory/items/${id}`, payload);
  }

  async getExpiring(days: number): Promise<ExpiringLot[]> {
    const { data } = await apiClient.get<{ days: number; lots: ExpiringLot[] }>(
      '/api/inventory/expiring',
      { params: { days } },
    );
    return data.lots;
  }

  async createWriteOff(payload: WriteOffPayload): Promise<void> {
    await apiClient.post('/api/inventory/write-offs', payload);
  }

  async getWriteOffs(): Promise<WriteOff[]> {
    const { data } = await apiClient.get<WriteOff[]>('/api/inventory/write-offs');
    return data;
  }
}
