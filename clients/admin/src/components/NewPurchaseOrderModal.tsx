import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import type { CreatePurchaseOrderPayload, InventoryStock, Supplier } from '../types';

interface Props {
  open: boolean;
  /** Active suppliers only — a retired one should not receive new orders. */
  suppliers: Supplier[];
  items: InventoryStock[];
  onClose: () => void;
  onCreate: (payload: CreatePurchaseOrderPayload) => Promise<void>;
}

interface DraftLine {
  raw_item_id: string;
  quantity: string;
  price: string;
}

const inputClass =
  'w-full rounded-lg border border-surface-sand-border bg-white px-3 py-2 text-sm text-surface-dark ' +
  'focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30';

/**
 * Raise a purchase order. It is created as a DRAFT — placing it is a separate,
 * deliberate step, because that is what turns it into a commitment the supplier
 * can deliver against.
 */
export default function NewPurchaseOrderModal({
  open,
  suppliers,
  items,
  onClose,
  onCreate,
}: Props) {
  const [supplierId, setSupplierId] = useState('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ raw_item_id: '', quantity: '', price: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSupplierId('');
      setExpected('');
      setNotes('');
      setLines([{ raw_item_id: '', quantity: '', price: '' }]);
      setSaving(false);
      setError(null);
    }
  }, [open]);

  // An ingredient already on the order is not offered again: two lines for one
  // item would make "how much is outstanding" ambiguous, and the database
  // rejects it anyway.
  const chosen = new Set(lines.map((l) => l.raw_item_id).filter(Boolean));

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!supplierId) {
      setError('اختر المورّد.');
      return;
    }
    const parsed = lines
      .filter((l) => l.raw_item_id)
      .map((l) => ({
        raw_item_id: l.raw_item_id,
        quantity_ordered: Number(l.quantity),
        unit_price: Number(l.price),
      }));

    if (parsed.length === 0) {
      setError('أضف صنفًا واحدًا على الأقل.');
      return;
    }
    if (parsed.some((l) => !Number.isFinite(l.quantity_ordered) || l.quantity_ordered <= 0)) {
      setError('الكمية المطلوبة يجب أن تكون أكبر من صفر.');
      return;
    }
    if (parsed.some((l) => !Number.isFinite(l.unit_price) || l.unit_price < 0)) {
      setError('السعر المتفق عليه يجب أن يكون صفرًا أو أكثر.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onCreate({
        supplier_id: supplierId,
        expected_at: expected ? new Date(expected).toISOString() : null,
        notes: notes.trim() || null,
        lines: parsed,
      });
      onClose();
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      setError(msg ?? 'تعذّر إنشاء أمر الشراء.');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="أمر شراء جديد" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="المورّد">
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            required
            className={inputClass}
          >
            <option value="" disabled>
              اختر مورّدًا…
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {suppliers.length === 0 && (
            <span className="mt-1 block text-[11px] text-warning-strong">
              لا يوجد مورّدون نشطون — أضف مورّدًا أولًا من صفحة المورّدين.
            </span>
          )}
        </Field>

        <Field label="التوريد المتوقّع (اختياري)">
          <input
            type="date"
            dir="ltr"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            className={`${inputClass} font-numerals text-start`}
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-xs font-semibold text-slate-500">الأصناف</span>
          <div className="space-y-2">
            {lines.map((line, idx) => (
              <div key={idx} className="flex flex-wrap items-start gap-2">
                <select
                  value={line.raw_item_id}
                  aria-label={`المكوّن ${idx + 1}`}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((l, i) => (i === idx ? { ...l, raw_item_id: e.target.value } : l)),
                    )
                  }
                  className={`${inputClass} flex-1 min-w-[10rem]`}
                >
                  <option value="">اختر مكوّنًا…</option>
                  {items
                    .filter((it) => it.id === line.raw_item_id || !chosen.has(it.id))
                    .map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} — {it.unit_of_measure}
                      </option>
                    ))}
                </select>
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  dir="ltr"
                  aria-label={`الكمية ${idx + 1}`}
                  placeholder="الكمية"
                  value={line.quantity}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((l, i) => (i === idx ? { ...l, quantity: e.target.value } : l)),
                    )
                  }
                  className={`${inputClass} w-24 font-numerals text-start`}
                />
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  dir="ltr"
                  aria-label={`السعر ${idx + 1}`}
                  placeholder="السعر"
                  value={line.price}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((l, i) => (i === idx ? { ...l, price: e.target.value } : l)),
                    )
                  }
                  className={`${inputClass} w-24 font-numerals text-start`}
                />
                {lines.length > 1 && (
                  <button
                    type="button"
                    aria-label={`حذف السطر ${idx + 1}`}
                    onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                    className="rounded-lg px-2 py-2 text-xs font-bold text-destructive-strong transition-colors hover:bg-destructive-soft"
                  >
                    حذف
                  </button>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, { raw_item_id: '', quantity: '', price: '' }])}
            className="mt-2 rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100"
          >
            + إضافة صنف
          </button>
        </div>

        <Field label="ملاحظات (اختياري)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="رقم الطلب لدى المورّد، تعليمات التسليم…"
            className={inputClass}
          />
        </Field>

        {error && (
          <p role="alert" className="text-xs font-semibold text-destructive-strong">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            إلغاء
          </Button>
          <Button variant="primary" type="submit" disabled={saving || suppliers.length === 0}>
            {saving ? 'جارٍ الإنشاء…' : 'إنشاء كمسودّة'}
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
