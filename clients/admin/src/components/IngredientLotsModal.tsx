import { useEffect, useState } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import type { InventoryStock, StockLot } from '../types';

interface Props {
  /** The ingredient whose lots are being inspected, or null when closed. */
  item: InventoryStock | null;
  onClose: () => void;
  loadLots: (id: string) => Promise<StockLot[]>;
  onCorrect: (lotId: string, cost: number) => Promise<number>;
}

const money = (n: number) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The stock lots behind one ingredient, with an editable cost.
 *
 * A cost belongs to a LOT, not to an ingredient: two deliveries of the same
 * thing at different prices are two lots, and FIFO draws them down in order.
 * The aggregated stock table cannot show that, which is why correcting a
 * mis-keyed cost needs this view at all.
 *
 * The reassurance under the field is not decoration. Someone about to change a
 * recorded cost reasonably fears they are rewriting last month's profit — they
 * are not, because 0015 captured the cost of every sale at the moment it
 * happened, and this only moves stock value and future deductions.
 */
export default function IngredientLotsModal({ item, onClose, loadLots, onCorrect }: Props) {
  const [lots, setLots] = useState<StockLot[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setLoading(true);
    setEditing(null);
    setError(null);
    setDone(null);
    loadLots(item.id)
      .then(setLots)
      .catch(() => setError('تعذّر تحميل الدفعات.'))
      .finally(() => setLoading(false));
  }, [item, loadLots]);

  if (!item) return null;

  async function save(lot: StockLot) {
    const next = Number(draft);
    if (!Number.isFinite(next) || next < 0) {
      setError('التكلفة يجب أن تكون رقمًا صفرًا أو أكثر.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const previous = await onCorrect(lot.id, next);
      setLots((all) =>
        all.map((l) =>
          l.id === lot.id
            ? { ...l, cost_at_purchase: next, value_remaining: l.quantity_remaining * next }
            : l,
        ),
      );
      // Showing the old value back is the point: a correction you cannot see
      // the before-and-after of is one you have to take on trust.
      setDone(`تم التصحيح من ${money(previous)} إلى ${money(next)} ج.م`);
      setEditing(null);
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      setError(msg ?? 'تعذّر تصحيح التكلفة.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`دفعات — ${item.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          التكلفة تخصّ الدفعة وليس الصنف. تصحيحها يغيّر قيمة المخزون والخصم مستقبلًا، ولا يمسّ
          تكلفة المبيعات المسجّلة سابقًا.
        </p>

        {loading ? (
          <p className="py-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
        ) : lots.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">لا توجد دفعات لهذا الصنف.</p>
        ) : (
          <ul className="divide-y divide-surface-sand-border rounded-xl border border-surface-sand-border">
            {lots.map((lot) => (
              <li key={lot.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-slate-600">
                    <span className="font-numerals font-semibold text-surface-dark">
                      {lot.quantity_remaining}
                    </span>{' '}
                    / <span className="font-numerals">{lot.quantity_received}</span>{' '}
                    {item.unit_of_measure}
                    {lot.supplier_name && (
                      <span className="ms-2 text-slate-400">· {lot.supplier_name}</span>
                    )}
                    <span className="ms-2 text-slate-400">
                      · استُلمت {new Date(lot.received_at).toLocaleDateString('en-GB')}
                    </span>
                    {/* The invoice figure, and whether the lot's own arithmetic
                        still agrees with it. A gap means the rate was rounded,
                        which is exactly what someone checking a supplier's bill
                        is looking for — so it is shown rather than smoothed. */}
                    {lot.total_cost !== null && (
                      <span className="mt-0.5 block text-slate-500">
                        الفاتورة{' '}
                        <span className="font-numerals font-semibold">
                          {money(lot.total_cost)}
                        </span>{' '}
                        ج.م
                        {Math.abs(Number(lot.implied_total) - Number(lot.total_cost)) >= 0.01 && (
                          <span className="ms-1 text-warning-strong">
                            (حساب الدفعة{' '}
                            <span className="font-numerals">{money(lot.implied_total)}</span> —
                            فارق تقريب)
                          </span>
                        )}
                      </span>
                    )}
                  </div>

                  {editing === lot.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={draft}
                        autoFocus
                        disabled={busy}
                        onChange={(e) => setDraft(e.target.value)}
                        className="w-28 rounded-lg border border-surface-sand-border px-2 py-1 font-numerals text-sm focus:border-twilight-500 focus:outline-none"
                      />
                      <Button type="button" onClick={() => save(lot)} disabled={busy}>
                        {busy ? '…' : 'حفظ'}
                      </Button>
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => setEditing(null)}
                        disabled={busy}
                      >
                        إلغاء
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <span className="font-numerals text-sm font-semibold text-surface-dark">
                        {money(lot.cost_at_purchase)} ج.م
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(lot.id);
                          setDraft(String(lot.cost_at_purchase));
                          setDone(null);
                          setError(null);
                        }}
                        className="rounded-lg px-2 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100/60"
                      >
                        تصحيح التكلفة
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {done && <p className="text-xs font-semibold text-twilight-700">{done}</p>}
        {error && (
          <p role="alert" className="text-xs font-semibold text-destructive-strong">
            {error}
          </p>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="secondary" type="button" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </div>
    </Modal>
  );
}
