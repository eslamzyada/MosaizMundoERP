import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { EXPORTS, EXPORT_NAMES } from '../lib/reportExports';
import { ReportFailed, runReport } from '../lib/runReport';
import { renderReportPdf } from '../lib/pdfReport';
import { renderReportWorkbook } from '../lib/xlsxReport';

/**
 * Taking a report out of the system.
 *
 * Generated on the SERVER rather than in the browser, for three reasons that
 * each rule out the client on their own: the figures must match what the API
 * computed (here they are literally the same call), the Arabic fonts and their
 * licence live here, and the till — which has no browser — will eventually want
 * the same files.
 */

export const FORMATS = ['pdf', 'xlsx'] as const;
export type Format = (typeof FORMATS)[number];

const CONTENT_TYPE: Record<Format, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * The name the file lands on disk with.
 *
 * ASCII only, and it carries the period. A file called "report.pdf" is
 * indistinguishable from last month's the moment it is saved, and three of them
 * in a downloads folder are worse than none. Arabic is deliberately NOT used:
 * a non-ASCII filename needs RFC 5987 encoding that older clients mangle, and a
 * corrupted name is worse than an English one.
 */
export function exportFilename(slug: string, from: string, to: string, format: Format): string {
  const safe = (s: string) => s.replace(/[^0-9A-Za-z-]/g, '');
  return `mosaiz-${safe(slug)}-${safe(from)}_${safe(to)}.${format}`;
}

/** The restaurant's trading name, for the masthead. Absent is not an error. */
async function organizationName(req: Request): Promise<string | null> {
  try {
    const row = await req.tx!.organization_branding.findFirst({ select: { display_name: true } });
    return row?.display_name ?? null;
  } catch {
    // A report that fails because the restaurant never set a display name would
    // be a strange thing to explain.
    return null;
  }
}

/**
 * GET /api/exports/:report?format=pdf|xlsx&days=|from=&to=
 *
 * FINANCE_ROLES only, by the route — the same gate as the reports themselves,
 * because this is the same data in a more portable container.
 */
export async function exportReport(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const definition = EXPORTS[req.params.report];
  if (!definition) {
    res.status(404).json({ error: `Unknown report. Available: ${EXPORT_NAMES.join(', ')}` });
    return;
  }

  const requested = req.query.format;
  if (typeof requested !== 'string' || !(FORMATS as readonly string[]).includes(requested)) {
    res.status(400).json({ error: `format must be one of: ${FORMATS.join(', ')}` });
    return;
  }
  const format = requested as Format;

  try {
    // The report's OWN handler produces the figures, so an export can never
    // disagree with the screen it was taken from.
    const data = await runReport<{ from: string; to: string }>(definition.handler, req);
    const ctx = { organizationName: await organizationName(req) };

    const body =
      format === 'pdf'
        ? await renderReportPdf(definition.toDocument(data as never, ctx))
        : await renderReportWorkbook(definition.toWorkbook(data as never, ctx));

    res.status(200);
    res.setHeader('Content-Type', CONTENT_TYPE[format]);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${exportFilename(definition.slug, data.from, data.to, format)}"`,
    );
    // Browsers cannot read a header they were not offered, and the admin needs
    // this one to name the saved file.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  } catch (err) {
    if (err instanceof ReportFailed) {
      // A bad date range stays a 400. Flattening it to 500 would tell the
      // caller to wait for someone else to fix what they can fix themselves.
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error('exports failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
