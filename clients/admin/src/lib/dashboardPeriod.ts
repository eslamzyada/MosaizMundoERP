/**
 * The window a dashboard figure covers, and the fact that it says so.
 *
 * The page carried the sentence "نظرة عامة على أداء اليوم" — an overview of
 * TODAY — above numbers summed in the browser from the most recent hundred
 * orders, with no date filter anywhere. On a quiet week that reached back days
 * and counted them as today; on a busy day it truncated today to a hundred.
 *
 * A period a manager can choose is the smaller half of the fix. The larger half
 * is that the window is now STATED, so the number and its caption cannot come
 * apart again.
 */
export interface Period {
  key: 'today' | 'week' | 'month';
  /** On the selector. */
  label: string;
  /** Under the heading, so the window is never implied. */
  caption: string;
  /** What the API is asked for. */
  days: number;
}

export const PERIODS: Period[] = [
  { key: 'today', label: 'اليوم', caption: 'أداء اليوم', days: 1 },
  { key: 'week', label: '٧ أيام', caption: 'أداء آخر ٧ أيام', days: 7 },
  { key: 'month', label: '٣٠ يومًا', caption: 'أداء آخر ٣٠ يومًا', days: 30 },
];

export const DEFAULT_PERIOD = PERIODS[0];

/**
 * Change from one window to the equivalent one before it.
 *
 * Null when there is nothing honest to compare against: growth from zero is
 * not "infinity per cent", and showing a first day as an enormous rise is a
 * lie told with arithmetic.
 */
export function changeFrom(previous: number, current: number): number | null {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  if (previous === 0) return null;
  return (current - previous) / previous;
}
