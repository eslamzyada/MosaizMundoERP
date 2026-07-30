import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import Modal from './ui/Modal';
import Button from './Button';
import type { InventoryStock, ReceiveStockPayload, Supplier } from '../types';

interface Props {
  open: boolean;
  items: InventoryStock[];
  /** Active suppliers only — retired ones stay on past lots but are not offered. */
  suppliers: Supplier[];
  /** Preselected ingredient (e.g. the row whose "استلام" button was clicked). */
  initialItemId?: string;
  onClose: () => void;
  onReceive: (payload: ReceiveStockPayload) => Promise<void>;
}

const inputClass =
  'w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-ink ' +
  'focus:border-twilight-500 focus:outline-none focus:ring-2 focus:ring-twilight-500/30';

/**
 * Records a new FIFO stock lot. Expiry is optional — non-perishables (bottled
 * water) legitimately have none, and the backend sorts undated lots last.
 */
const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ReceiveStockModal({
  open,
  items,
  suppliers,
  initialItemId,
  onClose,
  onReceive,
}: Props) {
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [cost, setCost] = useState('');
  const [totalCost, setTotalCost] = useState('');
  /** Which figure the user is typing; the other is derived and shown. */
  const [costMode, setCostMode] = useState<'unit' | 'total'>('unit');
  const [expiry, setExpiry] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset each time the modal opens, honouring the preselected row.
  useEffect(() => {
    if (open) {
      setItemId(initialItemId ?? '');
      setQuantity('');
      setCost('');
      setTotalCost('');
      setCostMode('unit');
      setExpiry('');
      setSupplierId('');
      setSaving(false);
      setError(null);
    }
  }, [open, initialItemId]);

  const selected = items.find((i) => i.id === itemId);

  // The lot stores a per-unit cost, so a total typed by the user is divided by
  // the quantity before it is sent. Both figures are shown either way, because
  // the whole point is that the person can see which one they have entered.
  const qtyNum = Number(quantity);
  const hasQty = Number.isFinite(qtyNum) && qtyNum > 0;
  const unitCostNum =
    costMode === 'unit'
      ? Number(cost)
      : hasQty && Number.isFinite(Number(totalCost))
        ? Number(totalCost) / qtyNum
        : NaN;
  const derived =
    hasQty && Number.isFinite(unitCostNum)
      ? costMode === 'unit'
        ? unitCostNum * qtyNum // show the invoice total
        : unitCostNum // show the per-unit price
      : null;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const qty = Number(quantity);
    // Always the PER-UNIT figure, whether it was typed directly or derived from
    // an invoice total. The lot column means cost per unit and nothing else.
    const unitCost = unitCostNum;
    if (!selected || !Number.isFinite(qty) || qty <= 0) return;
    if (!Number.isFinite(unitCost) || unitCost < 0) return;

    setSaving(true);
    setError(null);
    try {
      await onReceive({
        raw_item_id: selected.id,
        quantity_received: qty,
        // Send whichever figure was actually typed and let the server derive
        // the other. Dividing here and discarding the total is what made this
        // choice cosmetic: the invoice number never reached the database, so
        // nothing could ever be reconciled against the bill it came from.
        ...(costMode === 'unit'
          ? { cost_at_purchase: unitCost }
          : { total_cost: Number(totalCost) }),
        // Empty date field means "no expiry", not "today".
        expiry_date: expiry ? new Date(expiry).toISOString() : null,
        // Attribution is optional: a delivery can be recorded now and
        // attributed later rather than blocking the receipt.
        supplier_id: supplierId || null,
      });
      onClose();
    } catch {
      setError('تعذّر تسجيل الاستلام. حاول مرة أخرى.');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="استلام مخزون" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="المكوّن">
          <select
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            required
            className={inputClass}
          >
            <option value="" disabled>
              اختر مكوّنًا…
            </option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} — {i.unit_of_measure}
              </option>
            ))}
          </select>
        </Field>

        <Field label="المورّد (اختياري)">
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            className={inputClass}
          >
            <option value="">بدون مورّد محدّد</option>
            {suppliers.map((sup) => (
              <option key={sup.id} value={sup.id}>
                {sup.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-app-ink-muted">
            تحديد المورّد يتيح تتبّع تغيّر سعر الشراء لهذا المكوّن.
          </span>
        </Field>

        <Field label={selected ? `الكمية (${selected.unit_of_measure})` : 'الكمية'}>
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            dir="ltr"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
            placeholder="0"
            className={`${inputClass} font-numerals text-start`}
          />
        </Field>

        {/*
          The cost stored on a lot is PER UNIT — the FIFO walk multiplies it by
          the quantity drawn. Entering an invoice total instead of a unit price
          silently multiplies stock value by the quantity, and for an ingredient
          measured in grams the unit price is a number like 0.03, which looks
          wrong enough that people "correct" it into a total.

          So: say which unit, in the label, using the ingredient's own unit; let
          the total be typed instead, since that is what an invoice actually
          states; and show the arithmetic either way so a 1000x slip is visible
          before it is saved rather than at the next stocktake.
        */}
        <Field
          label={
            costMode === 'unit'
              ? `التكلفة لكل ${selected ? selected.unit_of_measure : 'وحدة'} (ج.م)`
              : 'إجمالي قيمة الفاتورة (ج.م)'
          }
        >
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            dir="ltr"
            value={costMode === 'unit' ? cost : totalCost}
            onChange={(e) =>
              costMode === 'unit' ? setCost(e.target.value) : setTotalCost(e.target.value)
            }
            required
            placeholder="0.00"
            className={`${inputClass} font-numerals text-start`}
          />

          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setCostMode(costMode === 'unit' ? 'total' : 'unit')}
              className="text-xs font-semibold text-twilight-700 underline-offset-2 hover:underline"
            >
              {costMode === 'unit' ? 'أدخل الإجمالي بدلًا من ذلك' : 'أدخل تكلفة الوحدة بدلًا من ذلك'}
            </button>

            {derived !== null && selected && (
              <span className="font-numerals text-xs text-app-ink-muted" dir="ltr">
                {costMode === 'unit'
                  ? `${qtyNum} ${selected.unit_of_measure} × ${money(unitCostNum)} = ${money(derived)} ج.م`
                  : `${money(derived)} ج.م / ${selected.unit_of_measure}`}
              </span>
            )}
          </div>
        </Field>

        <Field label="تاريخ الصلاحية (اختياري)">
          <input
            type="date"
            dir="ltr"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className={`${inputClass} font-numerals text-start`}
          />
        </Field>

        {error && <p className="text-xs font-semibold text-destructive-strong">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            إلغاء
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : 'تسجيل الاستلام'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-app-ink-muted">{label}</span>
      {children}
    </label>
  );
}
