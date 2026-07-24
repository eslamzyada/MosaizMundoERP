import { apiClient } from './client';
import type { InventoryRepository } from './InventoryRepository';
import axios from 'axios';
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

  async deleteIngredient(id: string): Promise<DeleteIngredientResult> {
    try {
      await apiClient.delete(`/api/inventory/items/${id}`);
      return { outcome: 'deleted' };
    } catch (err) {
      // 409 is not an error to surface as one: it is the API telling us the
      // ingredient has history and archiving is the supported path.
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        return { outcome: 'has_history', references: err.response.data.references };
      }
      throw err;
    }
  }

  async setIngredientActive(id: string, isActive: boolean): Promise<void> {
    await apiClient.patch(`/api/inventory/items/${id}`, { is_active: isActive });
  }

  async getItemLots(id: string): Promise<StockLot[]> {
    const { data } = await apiClient.get<StockLot[]>(`/api/inventory/items/${id}/batches`);
    return data;
  }

  async correctLotCost(lotId: string, cost: number): Promise<number> {
    const { data } = await apiClient.patch<{ previous_cost: number }>(
      `/api/inventory/batches/${lotId}/cost`,
      { cost_at_purchase: cost },
    );
    return data.previous_cost;
  }
}
