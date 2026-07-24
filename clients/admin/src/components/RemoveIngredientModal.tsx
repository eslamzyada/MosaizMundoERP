import { useState } from 'react';
import Modal from './ui/Modal';
import Button from './Button';
import type { IngredientReferences, InventoryStock } from '../types';

interface Props {
  /** The ingredient that could not be deleted, with what references it. */
  blocked: { item: InventoryStock; references: IngredientReferences } | null;
  onClose: () => void;
  onArchive: () => Promise<void>;
}

/**
 * Why an ingredient could not be deleted, and what to do instead.
 *
 * A bare "cannot delete" is a dead end. The counts are the whole point: they
 * name what is being protected, which is what makes the refusal reasonable
 * rather than arbitrary — and they make archiving read as the right answer
 * instead of a consolation prize.
 *
 * Deliberately NOT a browser confirm(). This has to explain that deleting would
 * erase recorded cost of goods sold and the consumption ledger that past
 * reports and any food-safety recall depend on, and one line of dialog text
 * cannot carry that.
 */
export default function RemoveIngredientModal({ blocked, onClose, onArchive }: Props) {
  const [busy, setBusy] = useState(false);

  if (!blocked) return null;
  const { item, references: r } = blocked;

  const rows: Array<[string, number]> = [
    ['وصفات تستخدمه', r.recipes],
    ['دفعات مخزون', r.stock_lots],
    ['عمليات استهلاك مسجّلة', r.consumption_records],
    ['عمليات إتلاف', r.write_offs],
    ['جرد سابق', r.stocktake_counts],
    ['بنود أوامر شراء', r.purchase_order_lines],
    ['عجز مسجّل', r.deficits],
  ];
  const present = rows.filter(([, n]) => n > 0);

  async function archive() {
    setBusy(true);
    try {
      await onArchive();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`لا يمكن حذف «${item.name}»`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          هذا المكوّن له سجل مرتبط به. حذفه سيمحو تكلفة مبيعات مسجّلة وسجلّ استهلاك تعتمد
          عليهما تقارير سابقة وتتبّع الدفعات عند أي استدعاء غذائي.
        </p>

        <div className="overflow-hidden rounded-xl border border-surface-sand-border">
          <ul className="divide-y divide-surface-sand-border text-sm">
            {present.map(([label, n]) => (
              <li key={label} className="flex justify-between px-4 py-2">
                <span className="text-slate-600">{label}</span>
                <span className="font-numerals font-semibold text-surface-dark">{n}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-surface-sand-border bg-surface-sand-alt/50 px-4 py-3">
          <p className="text-sm font-bold text-surface-dark">الأرشفة هي البديل</p>
          <p className="mt-1 text-xs text-slate-500">
            يختفي من قوائم الوصفات والاستلام واقتراحات الشراء، ويبقى سجلّه كاملًا. إن كان لديه
            رصيد فسيظل ظاهرًا في المخزون حتى ينفد — لأنه رصيد حقيقي على الرفّ.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            تراجع
          </Button>
          <Button type="button" onClick={archive} disabled={busy}>
            {busy ? 'جارٍ الأرشفة…' : 'أرشفة المكوّن'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
