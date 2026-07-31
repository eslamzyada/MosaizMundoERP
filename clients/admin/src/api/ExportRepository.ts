import { apiClient } from './client';
import type { ReportWindow } from '../types';

/**
 * Downloading a report.
 *
 * The file is built on the SERVER — this only asks for it and hands it to the
 * browser. Generating it here would mean a second implementation of every
 * report's arithmetic living in the client, drifting from the first, and it
 * would put the Arabic fonts and their licence in a bundle every visitor
 * downloads whether or not they ever export anything.
 */

export const EXPORT_FORMATS = ['pdf', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportableReport =
  | 'profitability'
  | 'waste'
  | 'purchasing'
  | 'trends'
  | 'inventory-assets'
  | 'employees'
  | 'voids';

function windowParams(window: ReportWindow): Record<string, string | number> {
  return window.kind === 'rolling'
    ? { days: window.days }
    : { from: window.from, to: window.to };
}

/** The name the server chose, which carries the period. */
function filenameFrom(disposition: unknown, fallback: string): string {
  if (typeof disposition !== 'string') return fallback;
  const match = disposition.match(/filename="?([^";]+)"?/);
  return match ? match[1] : fallback;
}

export const exportRepository = {
  /**
   * Fetches the file and saves it, resolving with the name it was saved under.
   *
   * Deliberately NOT a plain link to the endpoint: the request needs the bearer
   * token, and an <a href> cannot carry one. Fetching as a blob also means a
   * 403 arrives as a rejection this app can explain, rather than as a browser
   * tab showing raw JSON.
   */
  async download(
    report: ExportableReport,
    format: ExportFormat,
    window: ReportWindow,
  ): Promise<string> {
    const { data, headers } = await apiClient.get<Blob>(`/api/exports/${report}`, {
      params: { ...windowParams(window), format },
      responseType: 'blob',
    });

    const filename = filenameFrom(headers['content-disposition'], `${report}.${format}`);
    const url = URL.createObjectURL(data);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      // Revoked once the click has been dispatched; holding the object URL
      // keeps the whole file in memory for the life of the tab.
      URL.revokeObjectURL(url);
    }
    return filename;
  },
};
