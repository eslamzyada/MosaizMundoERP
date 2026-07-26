import { apiClient } from './client';
import type { PrinterRepository } from './PrinterRepository';
import type { CreatePrinterPayload, Printer, UpdatePrinterPayload } from '../types';

export class HttpPrinterRepository implements PrinterRepository {
  async list(): Promise<Printer[]> {
    const { data } = await apiClient.get<Printer[]>('/api/printers');
    return data;
  }

  async create(payload: CreatePrinterPayload): Promise<Printer> {
    const { data } = await apiClient.post<Printer>('/api/printers', payload);
    return data;
  }

  async update(id: string, payload: UpdatePrinterPayload): Promise<Printer> {
    const { data } = await apiClient.patch<Printer>(`/api/printers/${id}`, payload);
    return data;
  }

  async remove(id: string): Promise<void> {
    await apiClient.delete(`/api/printers/${id}`);
  }
}
