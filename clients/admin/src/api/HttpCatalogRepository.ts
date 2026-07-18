import { apiClient } from './client';
import type { CatalogRepository } from './CatalogRepository';
import type { CatalogItem, CreateItemPayload, UpdateItemPayload } from '../types';

/**
 * Live implementation. Create/update are owner/manager-only, enforced by the
 * database (0010 RESTRICTIVE policies) and answered as 403 by the API — the UI
 * hiding the controls is a courtesy, not the control.
 */
export class HttpCatalogRepository implements CatalogRepository {
  async getItems(): Promise<CatalogItem[]> {
    const { data } = await apiClient.get<CatalogItem[]>('/api/catalog/items');
    return data;
  }

  async createItem(payload: CreateItemPayload): Promise<CatalogItem> {
    const { data } = await apiClient.post<CatalogItem>('/api/catalog/items', payload);
    return data;
  }

  async updateItem(id: string, payload: UpdateItemPayload): Promise<CatalogItem> {
    const { data } = await apiClient.patch<CatalogItem>(`/api/catalog/items/${id}`, payload);
    return data;
  }
}
