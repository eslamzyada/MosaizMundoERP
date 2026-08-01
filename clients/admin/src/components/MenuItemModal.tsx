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
  onSave: (payload: {
    name: string;
    price: number;
    sku: string | null;
    /** Why. Required since 0035 — this is now a REQUEST, not an edit. */
    reason: string;
  }) => Promise<void>;
}

const inputClass =
  'w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-ink ' +
  'focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30';

/** Create or edit a menu item — name, price (the checkout-authoritative price), and an optional SKU. */
export default function MenuItemModal({ open, item, onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [sku, setSku] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the edited item's values (or blank) each time the modal opens.
  useEffect(() => {
    if (open) {
      setName(item?.name ?? '');
      setPrice(item ? String(item.price) : '');
      setSku(item?.sku ?? '');
      setReason('');
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
    // The server refuses a proposal without one, and it is what the person
    // approving actually decides on.
    if (reason.trim().length < 3) {
      setError('اكتب سبب التغيير — هو ما يُبنى عليه القرار.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmedName,
        price: numericPrice,
        sku: sku.trim() || null,
        reason: reason.trim(),
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

        {/* Pricing a dish without knowing what it costs is guesswork, so the
            margin updates as the price is typed. Only shown when editing: a new
            item has no recipe yet, so there is nothing to cost. */}
        {item && <PriceInsight item={item} price={price} />}

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

        {/* Since 0035 this form files a REQUEST rather than saving. The reason
            is the part somebody else reads before agreeing, so it is a field
            rather than an afterthought. */}
        <Field label="سبب التغيير">
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="مثال: ارتفع سعر اللحم من المورّد هذا الشهر"
            className={inputClass}
          />
        </Field>

        <p className="rounded-lg bg-app-surface-alt/60 px-3 py-2 text-xs text-app-ink-muted">
          لن يتغيّر شيء الآن: يُرسَل الطلب للاعتماد من المالك أو المدير الإقليمي.
        </p>

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

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * What the price being typed means for this dish: cost, profit per portion, and
 * food cost as a share of the price — recomputed on every keystroke.
 *
 * Margin is withheld whenever the cost is not fully known. A margin derived
 * from a partial cost overstates the profit, which would be worst exactly here,
 * at the moment the price is being decided.
 */
function PriceInsight({ item, price }: { item: CatalogItem; price: string }) {
  if (item.recipe_line_count === 0) {
    return (
      <p className="-mt-1 text-[11px] text-app-ink-muted">
        لا توجد وصفة لهذا الصنف بعد، فلا يمكن حساب التكلفة أو الهامش.
      </p>
    );
  }

  if (item.uncosted_line_count > 0) {
    return (
      <p className="-mt-1 text-[11px] font-semibold text-warning-strong">
        تكلفة جزئية: {money(item.total_cost)} ج.م على الأقل — {item.uncosted_line_count} مكوّن بلا
        رصيد في المخزون. الهامش غير مؤكّد.
      </p>
    );
  }

  const typed = Number(price);
  const priced = price.trim() !== '' && Number.isFinite(typed) && typed > 0;

  if (!priced) {
    return (
      <p className="-mt-1 text-[11px] text-app-ink-muted">
        التكلفة <span className="font-numerals">{money(item.total_cost)}</span> ج.م — أدخل سعرًا
        لرؤية الهامش.
      </p>
    );
  }

  const profit = typed - item.total_cost;
  const foodCostPct = (item.total_cost / typed) * 100;

  return (
    <p
      className={[
        '-mt-1 text-[11px]',
        profit < 0 ? 'font-semibold text-destructive-strong' : 'text-app-ink-muted',
      ].join(' ')}
    >
      التكلفة <span className="font-numerals">{money(item.total_cost)}</span> ج.م · الربح{' '}
      <span className="font-numerals font-semibold">{money(profit)}</span> ج.م · نسبة التكلفة{' '}
      <span className="font-numerals font-semibold">{foodCostPct.toFixed(1)}%</span>
      {profit < 0 && ' — السعر أقل من التكلفة'}
    </p>
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
