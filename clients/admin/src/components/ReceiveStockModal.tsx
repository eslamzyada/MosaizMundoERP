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
  'w-full rounded-lg border border-surface-sand-border bg-white px-3 py-2 text-sm text-surface-dark ' +
  'focus:border-twilight-500 focus:outline-none focus:ring-2 focus:ring-twilight-500/30';

/**
 * Records a new FIFO stock lot. Expiry is optional — non-perishables (bottled
 * water) legitimately have none, and the backend sorts undated lots last.
 */
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
      setExpiry('');
      setSupplierId('');
      setSaving(false);
      setError(null);
    }
  }, [open, initialItemId]);

  const selected = items.find((i) => i.id === itemId);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const qty = Number(quantity);
    const unitCost = Number(cost);
    if (!selected || !Number.isFinite(qty) || qty <= 0) return;
    if (!Number.isFinite(unitCost) || unitCost < 0) return;

    setSaving(true);
    setError(null);
    try {
      await onReceive({
        raw_item_id: selected.id,
        quantity_received: qty,
        cost_at_purchase: unitCost,
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
          <span className="mt-1 block text-[11px] text-slate-400">
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

        <Field label="تكلفة الوحدة (ج.م)">
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            dir="ltr"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            required
            placeholder="0.00"
            className={`${inputClass} font-numerals text-start`}
          />
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
      <span className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</span>
      {children}
    </label>
  );
}
