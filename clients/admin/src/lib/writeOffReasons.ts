/**
 * Why stock was written off (0023) — the codes the API accepts, with the Arabic
 * the person choosing actually reads.
 *
 * Ordered as they appear in the picker, most common first, with the escape
 * hatch last. The codes must match backend/src/lib/writeOffReasons.ts, which is
 * itself checked against the database constraint by a drift test.
 */
export const WRITE_OFF_REASONS = [
  {
    code: 'expired',
    label: 'انتهت صلاحيته',
    hint: 'تجاوز تاريخ الانتهاء — غالبًا شراء زائد',
  },
  {
    code: 'spoiled',
    label: 'تلف قبل انتهاء المدة',
    hint: 'خلل في التخزين أو التبريد',
  },
  {
    code: 'damaged',
    label: 'تلف أو كسر',
    hint: 'أثناء المناولة أو التوصيل',
  },
  {
    code: 'prep_error',
    label: 'خطأ في التحضير',
    hint: 'أُفسد أثناء الإعداد',
  },
  {
    code: 'staff_meal',
    label: 'وجبة موظفين',
    hint: 'ليست خسارة، لكنها ليست بيعًا',
  },
  {
    code: 'other',
    label: 'سبب آخر',
    hint: 'يتطلّب توضيحًا مكتوبًا',
  },
] as const;

export type WriteOffReasonCode = (typeof WRITE_OFF_REASONS)[number]['code'];

export const REASON_REQUIRING_NOTE: WriteOffReasonCode = 'other';
export const WRITE_OFF_NOTE_MAX_LENGTH = 500;

const LABELS: Record<string, string> = Object.fromEntries(
  WRITE_OFF_REASONS.map((r) => [r.code, r.label]),
);

/**
 * The Arabic label for a stored code, falling back to the code itself — if a
 * reason ever appears that this build does not know about, showing it raw is
 * how anyone finds out.
 */
export function writeOffReasonLabel(code: string | null): string {
  if (!code) return '—';
  return LABELS[code] ?? code;
}
