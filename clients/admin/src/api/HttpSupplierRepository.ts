import { apiClient } from './client';
import type { SupplierRepository } from './SupplierRepository';
import type {
  CreateSupplierPayload,
  Supplier,
  SupplierPriceRow,
  UpdateSupplierPayload,
} from '../types';

export class HttpSupplierRepository implements SupplierRepository {
  async list(): Promise<Supplier[]> {
    const { data } = await apiClient.get<Supplier[]>('/api/suppliers');
    return data;
  }

  async create(payload: CreateSupplierPayload): Promise<Supplier> {
    const { data } = await apiClient.post<Supplier>('/api/suppliers', payload);
    return data;
  }

  async update(id: string, payload: UpdateSupplierPayload): Promise<Supplier> {
    const { data } = await apiClient.patch<Supplier>(`/api/suppliers/${id}`, payload);
    return data;
  }

  async priceHistory(): Promise<SupplierPriceRow[]> {
    const { data } = await apiClient.get<SupplierPriceRow[]>('/api/suppliers/price-history');
    return data;
  }
}
