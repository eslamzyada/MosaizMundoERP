import { apiClient } from './client';
import type { ReportRepository } from './ReportRepository';
import type {
  EmployeeReport,
  InventoryAssetsReport,
  ProfitabilityReport,
  PurchasingReport,
  ReportWindow,
  TrendBucket,
  TrendsReport,
  VoidsReport,
  WasteReport,
} from '../types';

/**
 * A rolling window sends ?days, an explicit one sends ?from&to. Never both:
 * the server refuses half a range rather than guessing, so sending a stray
 * `days` alongside dates would be sending a question we did not mean to ask.
 */
function windowParams(window: ReportWindow): Record<string, string | number> {
  return window.kind === 'rolling'
    ? { days: window.days }
    : { from: window.from, to: window.to };
}

export class HttpReportRepository implements ReportRepository {
  async getProfitability(window: ReportWindow): Promise<ProfitabilityReport> {
    const { data } = await apiClient.get<ProfitabilityReport>('/api/reports/profitability', {
      params: windowParams(window),
    });
    return data;
  }

  async getVoids(window: ReportWindow): Promise<VoidsReport> {
    const { data } = await apiClient.get<VoidsReport>('/api/reports/voids', {
      params: windowParams(window),
    });
    return data;
  }

  async getWaste(window: ReportWindow): Promise<WasteReport> {
    const { data } = await apiClient.get<WasteReport>('/api/reports/waste', {
      params: windowParams(window),
    });
    return data;
  }

  async getInventoryAssets(window: ReportWindow): Promise<InventoryAssetsReport> {
    const { data } = await apiClient.get<InventoryAssetsReport>(
      '/api/reports/inventory-assets',
      { params: windowParams(window) },
    );
    return data;
  }

  async getEmployees(window: ReportWindow): Promise<EmployeeReport> {
    const { data } = await apiClient.get<EmployeeReport>('/api/reports/employees', {
      params: windowParams(window),
    });
    return data;
  }

  async getTrends(window: ReportWindow, bucket: TrendBucket = 'day'): Promise<TrendsReport> {
    const { data } = await apiClient.get<TrendsReport>('/api/reports/trends', {
      params: { ...windowParams(window), bucket },
    });
    return data;
  }

  async getPurchasing(window: ReportWindow): Promise<PurchasingReport> {
    const { data } = await apiClient.get<PurchasingReport>('/api/reports/purchasing', {
      params: windowParams(window),
    });
    return data;
  }
}
