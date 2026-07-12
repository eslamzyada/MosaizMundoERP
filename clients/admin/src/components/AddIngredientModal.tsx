import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Modal from './ui/Modal';
import Button from './Button';
import type { IngredientCategory, RawInventoryItem, RecipeLine } from '../types';

interface Props {
  open: boolean;
  ingredients: RawInventoryItem[];
  onClose: () => void;
  onAdd: (line: RecipeLine) => void;
}

const inputClass =
  'w-full rounded-lg border border-surface-sand-border bg-white px-3 py-2 text-sm text-surface-dark ' +
  'focus:border-twilight-500 focus:outline-none focus:ring-2 focus:ring-twilight-500/30';

export default function AddIngredientModal({ open, ingredients, onClose, onAdd }: Props) {
  const [ingredientId, setIngredientId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [category, setCategory] = useState<IngredientCategory>('purchased');

  // Reset the form each time the modal opens.
  useEffect(() => {
    if (open) {
      setIngredientId('');
      setQuantity('');
      setCategory('purchased');
    }
  }, [open]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const selected = ingredients.find((i) => i.id === ingredientId);
    const qty = Number(quantity);
    if (!selected || !Number.isFinite(qty) || qty <= 0) return;

    onAdd({
      raw_item: { ...selected, category },
      quantity_required: qty,
    });
    onClose();
  }

  return (
    <Modal open={open} title="إضافة مكوّن" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="المكوّن">
          <select
            value={ingredientId}
            onChange={(e) => setIngredientId(e.target.value)}
            required
            className={inputClass}
          >
            <option value="" disabled>
              اختر مكوّنًا…
            </option>
            {ingredients.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} — {i.unit_of_measure}
              </option>
            ))}
          </select>
        </Field>

        <Field label="الكمية">
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

        <Field label="نوع المكوّن">
          <div className="flex gap-2">
            <RadioChip
              name="category"
              checked={category === 'purchased'}
              onChange={() => setCategory('purchased')}
              label="مشتريات"
            />
            <RadioChip
              name="category"
              checked={category === 'intermediate'}
              onChange={() => setCategory('intermediate')}
              label="وسيط"
            />
          </div>
        </Field>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            إلغاء
          </Button>
          <Button variant="primary" type="submit">
            إضافة
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function RadioChip({
  name,
  checked,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label
      className={[
        'flex flex-1 cursor-pointer items-center justify-center rounded-lg border px-3 py-2 text-sm font-semibold transition-colors',
        checked
          ? 'border-twilight-600 bg-twilight-600 text-white'
          : 'border-surface-sand-border bg-white text-surface-dark hover:bg-surface-sand-alt',
      ].join(' ')}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      {label}
    </label>
  );
}
