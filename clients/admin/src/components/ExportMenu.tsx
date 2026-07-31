import { useState } from 'react';
import { exportRepository } from '../api/ExportRepository';
import type { ExportableReport, ExportFormat } from '../api/ExportRepository';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { ReportWindow } from '../types';

/**
 * Two buttons and the one thing that makes them trustworthy: they say what
 * happened.
 *
 * A download that silently does nothing is the worst version of this control —
 * the browser gives no feedback of its own when a fetch fails, so a 403 or a
 * dropped connection looks exactly like a click that did not register, and the
 * only recourse anyone has is to click it again.
 */

const LABELS: Record<ExportFormat, string> = {
  pdf: 'PDF',
  xlsx: 'Excel',
};

export default function ExportMenu({
  report,
  window,
  formats = ['pdf', 'xlsx'],
}: {
  report: ExportableReport;
  window: ReportWindow;
  formats?: ExportFormat[];
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function run(format: ExportFormat) {
    setBusy(format);
    setMessage(null);
    setFailed(false);
    try {
      const filename = await exportRepository.download(report, format, window);
      // Naming the file is not decoration: on most browsers the download lands
      // silently in a folder, and this is the only confirmation there is.
      setMessage(`تم تنزيل ${filename}`);
    } catch (err) {
      setFailed(true);
      setMessage(classifyLoadFailure(err).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="print:hidden">
      <div className="flex items-center gap-2">
        {formats.map((format) => (
          <button
            key={format}
            type="button"
            disabled={busy !== null}
            onClick={() => void run(format)}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm font-semibold text-app-ink transition-colors hover:bg-app-surface-alt disabled:opacity-50"
          >
            {busy === format ? 'جارٍ التحضير…' : `تنزيل ${LABELS[format]}`}
          </button>
        ))}
      </div>

      {message && (
        <p
          role="status"
          className={`mt-1.5 text-xs ${failed ? 'text-rose-600 dark:text-rose-400' : 'text-app-ink-muted'}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
