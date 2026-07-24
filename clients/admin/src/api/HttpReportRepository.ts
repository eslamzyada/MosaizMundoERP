import { apiClient } from './client';
import type { ReportRepository } from './ReportRepository';
import type { ProfitabilityReport, VoidsReport, WasteReport } from '../types';

export class HttpReportRepository implements ReportRepository {
  async getProfitability(days: number): Promise<ProfitabilityReport> {
    const { data } = await apiClient.get<ProfitabilityReport>('/api/reports/profitability', {
      params: { days },
    });
    return data;
  }

  async getVoids(days: number): Promise<VoidsReport> {
    const { data } = await apiClient.get<VoidsReport>('/api/reports/voids', {
      params: { days },
    });
    return data;
  }

  async getWaste(days: number): Promise<WasteReport> {
    const { data } = await apiClient.get<WasteReport>('/api/reports/waste', {
      params: { days },
    });
    return data;
  }
}
