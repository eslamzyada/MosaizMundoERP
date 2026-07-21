import { useEffect, useState } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import type { Order } from '../types';

interface Props {
  /** The order being voided, or null when the modal is closed. */
  order: Order | null;
  onClose: () => void;
  onVoid: (orderId: string, restoreStock: boolean) => Promise<void>;
}

/**
 * Voiding an order forces one question with no default: was the food made?
 *
 * The two answers do opposite things to the shelf — a mis-tap caught before
 * cooking means the ingredients never moved and must come back; a remake or a
 * walk-out means they are gone regardless of the refund. Only the person
 * standing there knows which happened, so the modal offers the two outcomes as
 * two explicit actions rather than a checkbox with a guessed default.
 */
export default function VoidOrderModal({ order, onClose, onVoid }: Props) {
  const [busy, setBusy] = useState<'restore' | 'keep' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (order) {
      setBusy(null);
      setError(null);
    }
  }, [order]);

  if (!order) return null;

  async function choose(restoreStock: boolean) {
    if (!order) return;
    setBusy(restoreStock ? 'restore' : 'keep');
    setError(null);
    try {
      await onVoid(order.id, restoreStock);
      onClose();
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      setError(msg ?? 'تعذّر إلغاء الطلب. حاول مرة أخرى.');
      setBusy(null);
    }
  }

  return (
    <Modal open title="إلغاء الطلب" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          إلغاء الطلب{' '}
          <span className="font-numerals font-semibold text-surface-dark">
            #{order.id.slice(0, 8)}
          </span>{' '}
          بقيمة{' '}
          <span className="font-numerals font-semibold text-surface-dark">
            {order.total_amount.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>{' '}
          ج.م — سيُستبعد من الإيرادات والتقارير.
        </p>

        <div className="rounded-xl border border-surface-sand-border bg-surface-sand-alt/50 px-4 py-3">
          <p className="text-sm font-bold text-surface-dark">هل تم تحضير الطعام؟</p>
          <p className="mt-1 text-xs text-slate-500">
            الإجابة تحدّد ما يحدث للمكوّنات المخصومة من المخزون، ولا يمكن تعديلها لاحقًا.
          </p>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => choose(true)}
            className="w-full rounded-xl border border-surface-sand-border bg-white px-4 py-3 text-start transition-colors hover:border-twilight-500 hover:bg-twilight-100/40 disabled:opacity-50"
          >
            <span className="block text-sm font-bold text-surface-dark">
              {busy === 'restore' ? 'جارٍ الإلغاء…' : 'لم يُحضَّر — أعد المكوّنات إلى المخزون'}
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              خطأ في التسجيل قبل التحضير: تعود كل كمية إلى نفس دفعة المخزون التي خُصمت منها.
            </span>
          </button>

          <button
            type="button"
            disabled={busy !== null}
            onClick={() => choose(false)}
            className="w-full rounded-xl border border-surface-sand-border bg-white px-4 py-3 text-start transition-colors hover:border-warning-strong hover:bg-warning-soft/30 disabled:opacity-50"
          >
            <span className="block text-sm font-bold text-surface-dark">
              {busy === 'keep' ? 'جارٍ الإلغاء…' : 'حُضِّر بالفعل — المكوّنات استُهلكت'}
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              إعادة تحضير أو هدر: يُصحَّح المبلغ فقط، ويبقى المخزون مخصومًا كما هو.
            </span>
          </button>
        </div>

        {error && (
          <p role="alert" className="text-xs font-semibold text-destructive-strong">
            {error}
          </p>
        )}

        <div className="flex justify-end pt-1">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy !== null}>
            تراجع
          </Button>
        </div>
      </div>
    </Modal>
  );
}
