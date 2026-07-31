import { Request, Response } from 'express';
import { convertDecimals } from './json';

/**
 * Reads a report by running the REAL handler and catching what it answers.
 *
 * WHY NOT JUST QUERY AGAIN.
 *
 * Because then there would be two definitions of "the waste report" — the one
 * on screen and the one in the PDF — and they would agree right up until
 * somebody changed one of them. The failure is silent and slow: a printed
 * report circulated to people who will not see the screen, quoting a figure the
 * system stopped calculating that way months ago. Extracting each handler into
 * a shared `compute` function would achieve the same thing, at the cost of
 * rewriting seven handlers that are currently covered by a hundred passing
 * assertions; this achieves it without touching them at all.
 *
 * The fake Response implements exactly what the handlers use — `status()` and
 * `json()` — and applies the same Decimal conversion the app-level interceptor
 * does, so an export sees the identical shape a browser would.
 */

export class ReportFailed extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (req: Request, res: Response) => Promise<void>;

export async function runReport<T>(handler: Handler, req: Request): Promise<T> {
  let status = 200;
  let body: unknown = undefined;
  let answered = false;

  const capture = {
    status(code: number) {
      status = code;
      return capture;
    },
    json(payload: unknown) {
      body = convertDecimals(payload);
      answered = true;
      return capture;
    },
  } as unknown as Response;

  await handler(req, capture);

  if (!answered) {
    throw new ReportFailed(500, 'The report produced no response');
  }
  if (status !== 200) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : 'The report could not be produced';
    // Carried through rather than flattened: a bad date range is the caller's
    // to fix, and answering 500 would tell them to wait for someone else to.
    throw new ReportFailed(status, message);
  }

  return body as T;
}
