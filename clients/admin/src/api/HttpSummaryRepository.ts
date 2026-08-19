import { apiClient } from './client';

/**
 * The dashboard's headline figures, computed where the rows are.
 *
 * They used to be summed in this browser from GET /api/pos/orders — the most
 * recent hundred orders, no date filter — under a heading that said "today".
 * Neither today's nor complete, and wrong in both directions: a quiet week
 * reached back days, a busy day was truncated at a hundred.
 */
export interface DashboardSummary {
  revenue: number;
  orders: number;
  /** Null for a window with no orders: an average of nothing is not zero. */
  average_order: number | null;
  /** The equivalent window immediately before, so a number has a baseline. */
  previous: {
    revenue: number;
    orders: number;
    average_order: number | null;
  };
}

export class HttpSummaryRepository {
  async getSummary(days: number): Promise<DashboardSummary> {
    const { data } = await apiClient.get<DashboardSummary>(
      `/api/reports/summary?days=${days}`,
    );
    return data;
  }
}
