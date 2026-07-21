import { apiClient } from './client';
import type { StocktakeCount, StocktakeRepository } from './StocktakeRepository';
import type { Stocktake, StocktakeSummary } from '../types';

export class HttpStocktakeRepository implements StocktakeRepository {
  async list(): Promise<StocktakeSummary[]> {
    const { data } = await apiClient.get<StocktakeSummary[]>('/api/inventory/stocktakes');
    return data;
  }

  async get(id: string): Promise<Stocktake> {
    const { data } = await apiClient.get<Stocktake>(`/api/inventory/stocktakes/${id}`);
    return data;
  }

  async start(): Promise<Stocktake> {
    const { data } = await apiClient.post<Stocktake>('/api/inventory/stocktakes', {});
    return data;
  }

  async saveCounts(id: string, counts: StocktakeCount[]): Promise<void> {
    await apiClient.patch(`/api/inventory/stocktakes/${id}/items`, { counts });
  }

  async post(id: string): Promise<void> {
    await apiClient.post(`/api/inventory/stocktakes/${id}/post`, {});
  }

  async cancel(id: string): Promise<void> {
    await apiClient.post(`/api/inventory/stocktakes/${id}/cancel`, {});
  }
}
