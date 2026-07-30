import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Modal from './ui/Modal';
import Button from './Button';
import type { RawInventoryItem } from '../types';

interface Props {
  open: boolean;
  ingredients: RawInventoryItem[];
  onClose: () => void;
  /**
   * Emits the new line as a payload rather than a RecipeLine: the line does not
   * exist yet, so it has no bill_of_materials id to carry.
   */
  onAdd: (payload: { raw_item_id: string; quantity_required: number }) => void;
}

const inputClass =
  'w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-ink ' +
  'focus:border-twilight-500 focus:outline-none focus:ring-2 focus:ring-twilight-500/30';

export default function AddIngredientModal({ open, ingredients, onClose, onAdd }: Props) {
  const [ingredientId, setIngredientId] = useState('');
  const [quantity, setQuantity] = useState('');

  // Reset the form each time the modal opens.
  useEffect(() => {
    if (open) {
      setIngredientId('');
      setQuantity('');
    }
  }, [open]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const selected = ingredients.find((i) => i.id === ingredientId);
    const qty = Number(quantity);
    if (!selected || !Number.isFinite(qty) || qty <= 0) return;

    onAdd({ raw_item_id: selected.id, quantity_required: qty });
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
      <span className="mb-1.5 block text-xs font-semibold text-app-ink-muted">{label}</span>
      {children}
    </label>
  );
}

