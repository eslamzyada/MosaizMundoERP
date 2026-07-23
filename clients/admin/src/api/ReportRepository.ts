import type { ProfitabilityReport, VoidsReport } from '../types';

// Data-access boundary for financial reporting. The API restricts this to
// FINANCE_ROLES; the UI hiding the page is a courtesy, not the control.
export interface ReportRepository {
  /** Revenue, cost of goods sold and margin over the last `days` days. */
  getProfitability(days: number): Promise<ProfitabilityReport>;
  /** What voiding cost over the last `days` days, grouped by cause (0022). */
  getVoids(days: number): Promise<VoidsReport>;
}
