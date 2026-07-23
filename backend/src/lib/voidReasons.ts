/**
 * Why an order was voided (0022).
 *
 * THE DATABASE IS THE SOURCE OF TRUTH. This list mirrors the
 * orders_void_reason_check constraint, and voidReasons.drift.test.ts asserts
 * the two agree against the live schema — so a value can never be offered by a
 * form, accepted by this validator, and then refused by Postgres. That failure
 * mode is nastier than it sounds: it surfaces at the till, mid-void, as an
 * unexplained error on a correction someone is standing there waiting to make.
 *
 * Each code names a different owner of the problem, which is the test for
 * whether one earns its place: wrong_item and duplicate point at training or
 * the button layout, kitchen_error at the kitchen, customer_complaint at the
 * recipe, customer_cancelled at nobody, test_order at nothing (it is excluded
 * from analysis). A walkout needs no code of its own — customer_cancelled with
 * the stock NOT restored already says the customer left and the food was made.
 */
export const VOID_REASONS = [
  'wrong_item',
  'duplicate',
  'customer_cancelled',
  'kitchen_error',
  'customer_complaint',
  'test_order',
  'other',
] as const;

export type VoidReason = (typeof VOID_REASONS)[number];

/**
 * The escape hatch has to explain itself.
 *
 * A closed list that cannot express a real event pushes people into whichever
 * wrong category is nearest, which quietly corrupts the categories that matter.
 * 'other' prevents that — and requiring a note is what keeps it from becoming
 * the path of least resistance for everything.
 */
export const REASON_REQUIRING_NOTE: VoidReason = 'other';

/** Matches the orders_void_note_wellformed bound; also asserted by the drift test. */
export const VOID_NOTE_MAX_LENGTH = 500;

export function isVoidReason(value: unknown): value is VoidReason {
  return typeof value === 'string' && (VOID_REASONS as readonly string[]).includes(value);
}
