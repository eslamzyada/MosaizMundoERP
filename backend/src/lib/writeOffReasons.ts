/**
 * Why stock was written off (0023).
 *
 * THE DATABASE IS THE SOURCE OF TRUTH. This mirrors the
 * stock_write_offs_reason_check constraint, and writeOffReasons.drift.test.ts
 * asserts the two agree against the live schema — the same guard the void
 * vocabulary gets, for the same reason: a value the form offers, this API
 * accepts, and Postgres then refuses is a failure that only shows up in front
 * of someone standing over a bin.
 *
 * Each code names a different owner of the problem, which is what makes the
 * report worth reading: 'expired' points at over-ordering or a slow-moving menu
 * item, 'spoiled' at storage, 'damaged' at handling, 'prep_error' at training.
 *
 * 'staff_meal' is not waste and is included deliberately. Stock that leaves for
 * a legitimate reason still has to leave the books, or it comes back as mystery
 * shrinkage at the next stocktake — attributed to nobody, explainable by no one.
 */
export const WRITE_OFF_REASONS = [
  'expired',
  'spoiled',
  'damaged',
  'prep_error',
  'staff_meal',
  'other',
] as const;

export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

/** The escape hatch has to explain itself, or the five real causes stop meaning anything. */
export const REASON_REQUIRING_NOTE: WriteOffReason = 'other';

/** Matches the stock_write_offs_note_wellformed bound; asserted by the drift test. */
export const WRITE_OFF_NOTE_MAX_LENGTH = 500;

/**
 * Reasons that represent food destroyed, as opposed to consumed on purpose.
 *
 * A staff meal costs the business exactly as much as a spoiled one, but it is
 * not a problem to fix — folding it into a "waste" headline would make the
 * kitchen look worse the better it feeds its people. Reporting keeps them apart.
 */
export const WASTE_REASONS: readonly WriteOffReason[] = [
  'expired',
  'spoiled',
  'damaged',
  'prep_error',
];

export function isWriteOffReason(value: unknown): value is WriteOffReason {
  return typeof value === 'string' && (WRITE_OFF_REASONS as readonly string[]).includes(value);
}
