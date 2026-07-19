import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import type { InventoryStock } from '../types';

interface Props {
  open: boolean;
  /** The ingredient being edited, or null to create a new one. */
  ingredient: InventoryStock | null;
  onClose: () => void;
  onSave: (payload: {
    name: string;
    unit_of_measure: string;
    reorder_threshold: number;
  }) => Promise<void>;
}

const inputClass =
  'w-full rounded-lg border border-surface-sand-border bg-white px-3 py-2 text-sm text-surface-dark ' +
  'focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30';

/**
 * Create or edit a raw ingredient — name, unit of measure, and the reorder
 * threshold below which the inventory dashboard flags it as low.
 */
export default function IngredientModal({ open, ingredient, onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [threshold, setThreshold] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(ingredient?.name ?? '');
      setUnit(ingredient?.unit_of_measure ?? '');
      setThreshold(ingredient ? String(ingredient.reorder_threshold) : '0');
      setSaving(false);
      setError(null);
    }
  }, [open, ingredient]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedUnit = unit.trim();
    const numericThreshold = Number(threshold);
    if (!trimmedName) {
      setError('أدخل اسم المكوّن.');
      return;
    }
    if (!trimmedUnit) {
      setError('أدخل وحدة القياس (مثال: جرام، قطعة).');
      return;
    }
    if (!Number.isFinite(numericThreshold) || numericThreshold < 0) {
      setError('الحد الأدنى يجب أن يكون صفرًا أو أكثر.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmedName,
        unit_of_measure: trimmedUnit,
        reorder_threshold: numericThreshold,
      });
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
    <Modal open={open} title={ingredient ? 'تعديل المكوّن' : 'إضافة مكوّن'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="اسم المكوّن">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="مثال: دجاج"
            className={inputClass}
          />
        </Field>

        <Field label="وحدة القياس">
          <input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            required
            placeholder="مثال: جرام"
            className={inputClass}
          />
        </Field>

        <Field label="الحد الأدنى لإعادة الطلب">
          <input
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            dir="ltr"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className={`${inputClass} font-numerals text-start`}
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            يُنبّه لوحة المخزون عندما يقل المتوفر عن هذا الحد. صفر = بدون تنبيه.
          </span>
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
            {saving ? 'جارٍ الحفظ…' : ingredient ? 'حفظ التغييرات' : 'إضافة'}
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
