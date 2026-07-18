import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import type { CatalogItem } from '../types';

interface Props {
  open: boolean;
  /** The item being edited, or null to create a new one. */
  item: CatalogItem | null;
  onClose: () => void;
  onSave: (payload: { name: string; price: number; sku: string | null }) => Promise<void>;
}

const inputClass =
  'w-full rounded-lg border border-surface-sand-border bg-white px-3 py-2 text-sm text-surface-dark ' +
  'focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30';

/** Create or edit a menu item — name, price (the checkout-authoritative price), and an optional SKU. */
export default function MenuItemModal({ open, item, onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [sku, setSku] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the edited item's values (or blank) each time the modal opens.
  useEffect(() => {
    if (open) {
      setName(item?.name ?? '');
      setPrice(item ? String(item.price) : '');
      setSku(item?.sku ?? '');
      setSaving(false);
      setError(null);
    }
  }, [open, item]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    const numericPrice = Number(price);
    if (!trimmedName) {
      setError('أدخل اسم الصنف.');
      return;
    }
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      setError('أدخل سعرًا صحيحًا (صفر أو أكثر).');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmedName, price: numericPrice, sku: sku.trim() || null });
      onClose();
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      setError(msg ?? 'تعذّر الحفظ. حاول مرة أخرى.');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title={item ? 'تعديل الصنف' : 'إضافة صنف'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="اسم الصنف">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="مثال: شاورما فراخ"
            className={inputClass}
          />
        </Field>

        <Field label="السعر (ج.م)">
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            dir="ltr"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
            placeholder="0.00"
            className={`${inputClass} font-numerals text-start`}
          />
        </Field>

        <Field label="رمز الصنف SKU (اختياري)">
          <input
            type="text"
            dir="ltr"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="SHW-1"
            className={`${inputClass} text-start`}
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
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : item ? 'حفظ التغييرات' : 'إضافة'}
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
