import type {
  EmployeeReport,
  InventoryAssetsReport,
  ProfitabilityReport,
  ReportWindow,
  VoidsReport,
  WasteReport,
} from '../types';

// Data-access boundary for financial reporting. The API restricts this to
// FINANCE_ROLES; the UI hiding the page is a courtesy, not the control.
export interface ReportRepository {
  /** Revenue, cost of goods sold and margin over the last `days` days. */
  getProfitability(window: ReportWindow): Promise<ProfitabilityReport>;
  /** What voiding cost over the last `days` days, grouped by cause (0022). */
  getVoids(window: ReportWindow): Promise<VoidsReport>;
  /** What the bin cost over the last `days` days, by cause, item and supplier (0023). */
  getWaste(window: ReportWindow): Promise<WasteReport>;
  /** Where capital is tied up in stock, how long it has sat, what is not moving. */
  getInventoryAssets(window: ReportWindow): Promise<InventoryAssetsReport>;
  /** How each person performed, from what the till recorded (0026). */
  getEmployees(window: ReportWindow): Promise<EmployeeReport>;
}
