import { apiClient } from './client';
import type { ReportRepository } from './ReportRepository';
import type { ProfitabilityReport, ReportWindow, VoidsReport, WasteReport } from '../types';

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
}
