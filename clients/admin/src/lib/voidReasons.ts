/**
 * Why an order was voided (0022) — the codes the API accepts, with the Arabic
 * the person choosing actually reads.
 *
 * The order here is the order they appear in the picker, and it is not
 * alphabetical: the everyday mistakes come first because they are what someone
 * is reaching for while a queue waits, and 'other' is last because it should be
 * the thing you land on after the real answers, not before them.
 *
 * The codes must match backend/src/lib/voidReasons.ts, which is itself checked
 * against the database constraint by voidReasons.drift.test.ts.
 */
export const VOID_REASONS = [
  {
    code: 'wrong_item',
    label: 'صنف خاطئ',
    hint: 'سُجِّل صنف أو كمية غير المطلوبة',
  },
  {
    code: 'duplicate',
    label: 'طلب مكرَّر',
    hint: 'نفس الطلب سُجِّل مرتين',
  },
  {
    code: 'customer_cancelled',
    label: 'العميل ألغى',
    hint: 'غيّر رأيه أو غادر قبل الدفع',
  },
  {
    code: 'kitchen_error',
    label: 'خطأ في التحضير',
    hint: 'حُضِّر بشكل خاطئ ويُعاد تحضيره',
  },
  {
    code: 'customer_complaint',
    label: 'شكوى عميل',
    hint: 'رفض الطعام بعد تقديمه',
  },
  {
    code: 'test_order',
    label: 'طلب تجريبي',
    hint: 'تدريب أو اختبار — يُستبعد من التحليل',
  },
  {
    code: 'other',
    label: 'سبب آخر',
    hint: 'يتطلّب توضيحًا مكتوبًا',
  },
] as const;

export type VoidReasonCode = (typeof VOID_REASONS)[number]['code'];

/** The one reason that has to explain itself. */
export const REASON_REQUIRING_NOTE: VoidReasonCode = 'other';

export const VOID_NOTE_MAX_LENGTH = 500;

const LABELS: Record<string, string> = Object.fromEntries(
  VOID_REASONS.map((r) => [r.code, r.label]),
);

/**
 * The Arabic label for a stored code.
 *
 * Falls back to the raw code rather than to a friendly placeholder: if a reason
 * ever appears that this build does not know about, showing it is how anyone
 * finds out. "غير معروف" would hide exactly the drift worth noticing.
 */
export function voidReasonLabel(code: string | null): string {
  if (!code) return '—';
  return LABELS[code] ?? code;
}
