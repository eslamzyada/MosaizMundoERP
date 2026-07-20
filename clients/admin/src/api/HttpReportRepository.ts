import { apiClient } from './client';
import type { ReportRepository } from './ReportRepository';
import type { ProfitabilityReport } from '../types';

export class HttpReportRepository implements ReportRepository {
  async getProfitability(days: number): Promise<ProfitabilityReport> {
    const { data } = await apiClient.get<ProfitabilityReport>('/api/reports/profitability', {
      params: { days },
    });
    return data;
  }
}
