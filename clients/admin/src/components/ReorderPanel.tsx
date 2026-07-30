import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Button from './Button';
import type { CreatePurchaseOrderPayload, ReorderSuggestion, Supplier } from '../types';

interface Props {
  suggestions: ReorderSuggestion[];
  suppliers: Supplier[];
  mayOrder: boolean;
  busy: boolean;
  /** Raises a draft order; the caller reloads and opens it. */
  onDraft: (payload: CreatePurchaseOrderPayload) => Promise<void>;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });

/**
 * What needs reordering, grouped by the supplier it would be bought from —
 * because an order goes to one supplier, so that is the unit of action.
 *
 * Quantities default to the shortfall and are fully editable. The default
 * brings stock back to its minimum and no further: this system has no par-level
 * data, and inventing a multiplier would look authoritative while being
 * arbitrary. The buyer knows their own delivery cadence; the panel just makes
 * the arithmetic visible.
 */
export default function ReorderPanel({ suggestions, suppliers, mayOrder, busy, onDraft }: Props) {
  // Quantity and supplier overrides, keyed by ingredient.
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [drafting, setDrafting] = useState<string | null>(null);

  const supplierOf = (s: ReorderSuggestion) =>
    chosen[s.raw_item_id] ?? s.suggested_supplier_id ?? '';
  const quantityOf = (s: ReorderSuggestion) => {
    const raw = quantities[s.raw_item_id];
    return raw === undefined ? String(Number(s.shortfall)) : raw;
  };

  // One group per supplier: an order is placed with a supplier, not per item.
  const groups = useMemo(() => {
    const map = new Map<string, ReorderSuggestion[]>();
    for (const s of suggestions) {
      const key = supplierOf(s) || '__none__';
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
    // supplierOf depends on `chosen`, so regroup when a supplier is picked.
  }, [suggestions, chosen]);

  if (suggestions.length === 0) {
    return (
      <section className="mb-6 rounded-2xl border border-app-border bg-app-surface px-6 py-5 text-sm text-app-ink-muted shadow-sm">
        كل المكوّنات فوق حدّها الأدنى — لا شيء يحتاج إعادة طلب.
      </section>
    );
  }

  async function draftFor(supplierId: string, rows: ReorderSuggestion[]) {
    const lines = rows
      .map((s) => ({
        raw_item_id: s.raw_item_id,
        quantity_ordered: Number(quantityOf(s)),
        unit_price: Number(s.suggested_unit_price ?? 0),
      }))
      .filter((l) => Number.isFinite(l.quantity_ordered) && l.quantity_ordered > 0);
    if (lines.length === 0) return;

    setDrafting(supplierId);
    try {
      await onDraft({ supplier_id: supplierId, lines });
    } finally {
      setDrafting(null);
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-2xl border border-warning-soft bg-app-surface shadow-sm">
      <div className="border-b border-app-border bg-warning-soft/30 px-6 py-4">
        <h2 className="text-sm font-bold text-app-ink">
          {suggestions.length} مكوّن تحت الحدّ الأدنى
        </h2>
        <p className="mt-0.5 text-xs text-app-ink-muted">
          الكمية المقترحة تعيد الرصيد إلى الحدّ الأدنى فقط، بعد خصم ما هو قيد التوريد بالفعل —
          عدّلها حسب دورة التوريد لديك.
        </p>
      </div>

      {groups.map(([supplierId, rows]) => {
        const named = suppliers.find((s) => s.id === supplierId);
        const unassigned = supplierId === '__none__';
        return (
          <div key={supplierId} className="border-b border-app-border/70 last:border-b-0">
            <div className="flex flex-wrap items-center justify-between gap-3 bg-app-surface-alt/40 px-6 py-2.5">
              <p className="text-xs font-bold text-app-ink">
                {unassigned ? 'بلا مورّد محدّد' : (named?.name ?? '—')}
                {!unassigned && (
                  <span className="ms-2 font-normal text-app-ink-muted">
                    {rows.length} صنف
                  </span>
                )}
              </p>
              {mayOrder && !unassigned && (
                <Button
                  variant="primary"
                  disabled={busy || drafting !== null}
                  onClick={() => draftFor(supplierId, rows)}
                >
                  {drafting === supplierId ? 'جارٍ الإنشاء…' : 'إنشاء أمر شراء'}
                </Button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-app-border/70 text-sm">
                <caption className="sr-only">مكوّنات تحتاج إعادة طلب</caption>
                <thead>
                  <tr>
                    <Th>المكوّن</Th>
                    <Th>المتوفّر</Th>
                    <Th>الحدّ الأدنى</Th>
                    <Th>قيد التوريد</Th>
                    <Th>الكمية المقترحة</Th>
                    <Th>آخر سعر</Th>
                    {mayOrder && <Th>المورّد</Th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/70">
                  {rows.map((s) => (
                    <tr key={s.raw_item_id} className="transition-colors hover:bg-app-bg/60">
                      <td className="px-6 py-3 font-semibold text-app-ink">
                        {s.name}
                        <span className="ms-2 text-xs font-normal text-app-ink-muted">
                          {s.unit_of_measure}
                        </span>
                      </td>
                      <td className="px-6 py-3 font-numerals text-destructive-strong">
                        {qty(Number(s.quantity_on_hand))}
                      </td>
                      <td className="px-6 py-3 font-numerals text-app-ink-muted">
                        {qty(Number(s.reorder_threshold))}
                      </td>
                      <td className="px-6 py-3 font-numerals text-app-ink-muted">
                        {Number(s.quantity_on_order) > 0 ? qty(Number(s.quantity_on_order)) : '—'}
                      </td>
                      <td className="px-6 py-3">
                        {mayOrder ? (
                          <input
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            dir="ltr"
                            aria-label={`الكمية المطلوبة من ${s.name}`}
                            value={quantityOf(s)}
                            disabled={busy}
                            onChange={(e) =>
                              setQuantities((q) => ({ ...q, [s.raw_item_id]: e.target.value }))
                            }
                            className="w-24 rounded-lg border border-app-border bg-app-surface px-2 py-1 font-numerals text-start text-sm font-semibold text-app-ink focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30 disabled:opacity-50"
                          />
                        ) : (
                          <span className="font-numerals font-semibold text-app-ink">
                            {qty(Number(s.shortfall))}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-3 font-numerals text-app-ink-muted">
                        {s.suggested_unit_price === null
                          ? '—'
                          : money(Number(s.suggested_unit_price))}
                      </td>
                      {mayOrder && (
                        <td className="px-6 py-3">
                          <select
                            value={supplierOf(s)}
                            aria-label={`المورّد لـ ${s.name}`}
                            disabled={busy}
                            onChange={(e) =>
                              setChosen((c) => ({ ...c, [s.raw_item_id]: e.target.value }))
                            }
                            className="rounded-lg border border-app-border bg-app-surface px-2 py-1 text-xs text-app-ink focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30 disabled:opacity-50"
                          >
                            <option value="">اختر مورّدًا…</option>
                            {suppliers.map((sup) => (
                              <option key={sup.id} value={sup.id}>
                                {sup.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {unassigned && mayOrder && (
              <p className="px-6 py-3 text-xs text-app-ink-muted">
                لم يُشترَ أيٌّ من هذه المكوّنات من مورّد مسجَّل من قبل، فلا يوجد سعر سابق للاختيار
                بناءً عليه — حدّد المورّد يدويًا.
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-6 py-2.5 text-start text-[11px] font-bold uppercase tracking-wide text-app-ink-muted"
    >
      {children}
    </th>
  );
}
