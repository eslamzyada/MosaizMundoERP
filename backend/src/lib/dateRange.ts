import { Request } from 'express';

/**
 * The window a report covers.
 *
 * Every report until now took `?days=N` and measured backwards from "now",
 * which cannot express the question people actually ask of a report: "how did
 * last month go?" A rolling 30 days always includes today's half-finished
 * trading and slides forward every time you reload, so two people running the
 * same report an hour apart get different numbers and neither can quote them.
 *
 * `?from=` and `?to=` (calendar dates) fix that. `?days=` still works, because
 * the dashboards and the existing clients use it and a rolling window is
 * genuinely the right default for "how are we doing right now".
 */
export interface DateRange {
  /** Inclusive start instant. */
  from: Date;
  /** EXCLUSIVE end instant — the start of the day after `to`. */
  until: Date;
  /** What the caller asked for, echoed back so a report can label itself. */
  label: { from: string; to: string; days: number | null };
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366 * 3;

/** A calendar date with no time part, or null if it is not one. */
function parseDay(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function iso(d: Date): string {
  // Local calendar date, not UTC: a report labelled "1 July" must mean the day
  // the restaurant traded, not a day that shifts with the server's timezone.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class DateRangeError extends Error {}

/**
 * Reads the window from the query string.
 *
 * `from`/`to` are INCLUSIVE calendar days, which is what a person means by
 * "1 July to 31 July". Internally the end becomes the start of the next day so
 * the SQL comparison stays a half-open interval — `< until` rather than
 * `<= to` — and an order placed at 23:59 on the last day is still counted.
 * Getting that wrong silently drops the busiest hour of the final day.
 *
 * Throws DateRangeError for a range the caller can fix; the handler maps it to
 * a 400 rather than quietly substituting a different window than was asked for.
 */
export function parseDateRange(req: Request): DateRange {
  const from = parseDay(req.query.from);
  const to = parseDay(req.query.to);

  if ((req.query.from !== undefined && from === null) ||
      (req.query.to !== undefined && to === null)) {
    throw new DateRangeError('from and to must be calendar dates in YYYY-MM-DD form');
  }

  if (from && to) {
    if (from > to) {
      throw new DateRangeError('from must not be after to');
    }
    const until = new Date(to);
    until.setDate(until.getDate() + 1);
    until.setHours(0, 0, 0, 0);

    const spanDays = Math.round((until.getTime() - from.getTime()) / 86_400_000);
    if (spanDays > MAX_DAYS) {
      throw new DateRangeError(`the range must not exceed ${MAX_DAYS} days`);
    }

    return { from, until, label: { from: iso(from), to: iso(to), days: null } };
  }

  if (from || to) {
    throw new DateRangeError('give both from and to, or neither');
  }

  // Rolling window. `until` is tomorrow's start rather than "now" so that
  // today's sales are included — a report that stops at the current instant
  // makes "today" look like a bad day until closing time.
  const n = Number(req.query.days);
  const days = !Number.isFinite(n) || n < 1 ? DEFAULT_DAYS : Math.min(Math.floor(n), MAX_DAYS);

  const until = startOfDay(new Date());
  until.setDate(until.getDate() + 1);
  const start = new Date(until);
  start.setDate(start.getDate() - days);

  return { from: start, until, label: { from: iso(start), to: iso(new Date(until.getTime() - 1)), days } };
}
