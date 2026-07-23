import { useEffect, useState } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import {
  REASON_REQUIRING_NOTE,
  VOID_NOTE_MAX_LENGTH,
  VOID_REASONS,
  type VoidReasonCode,
} from '../lib/voidReasons';
import type { Order } from '../types';

interface Props {
  /** The order being voided, or null when the modal is closed. */
  order: Order | null;
  onClose: () => void;
  onVoid: (
    orderId: string,
    restoreStock: boolean,
    reason: VoidReasonCode,
    note: string,
  ) => Promise<void>;
}

/**
 * Voiding an order asks two questions, and they are not the same question.
 *
 * WHY (0022) is a fixed list, because free text cannot be counted: "wrong
 * order", "mistake" and "خطأ" are one event spelled three ways, and a void
 * nobody can total is a void nobody learns from. It is asked first because it
 * is what the person already knows — they are voiding *because* of something.
 *
 * WAS THE FOOD MADE (0018) decides what happens to the shelf, and has no
 * default: a mis-tap caught before cooking means the ingredients never moved
 * and must come back; a remake or a walk-out means they are gone regardless of
 * the refund. Only the person standing there knows which, so the two answers
 * are offered as two explicit actions rather than a checkbox with a guess.
 *
 * The two are deliberately independent — a kitchen error caught at the pass
 * restores stock, a cancellation after plating does not — so picking a reason
 * never preselects a stock answer.
 */
export default function VoidOrderModal({ order, onClose, onVoid }: Props) {
  const [reason, setReason] = useState<VoidReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'restore' | 'keep' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (order) {
      setReason(null);
      setNote('');
      setBusy(null);
      setError(null);
    }
  }, [order]);

  if (!order) return null;

  const noteRequired = reason === REASON_REQUIRING_NOTE;
  const noteTooLong = note.trim().length > VOID_NOTE_MAX_LENGTH;
  // The stock buttons stay inert until the void is actually answerable. The
  // API and the database both refuse an unreasoned void, so enabling them would
  // only turn a clear "pick a reason" into a failed request.
  const ready = reason !== null && (!noteRequired || note.trim() !== '') && !noteTooLong;

  async function choose(restoreStock: boolean) {
    if (!order || !reason || !ready) return;
    setBusy(restoreStock ? 'restore' : 'keep');
    setError(null);
    try {
      await onVoid(order.id, restoreStock, reason, note.trim());
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

        <fieldset>
          <legend className="text-sm font-bold text-surface-dark">ما سبب الإلغاء؟</legend>
          <p className="mt-1 text-xs text-slate-500">
            يُسجَّل السبب مع الطلب ويظهر في تقرير الإلغاءات — به تُعرف مشكلة التدريب من مشكلة
            المطبخ.
          </p>

          <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {VOID_REASONS.map((r) => {
              const selected = reason === r.code;
              return (
                <label
                  key={r.code}
                  className={`cursor-pointer rounded-xl border px-3 py-2 transition-colors ${
                    selected
                      ? 'border-twilight-500 bg-twilight-100/50'
                      : 'border-surface-sand-border bg-white hover:border-twilight-500/50'
                  } ${busy !== null ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="void_reason"
                    value={r.code}
                    checked={selected}
                    disabled={busy !== null}
                    onChange={() => setReason(r.code)}
                    className="sr-only"
                  />
                  <span className="block text-sm font-bold text-surface-dark">{r.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{r.hint}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {reason !== null && (
          <div>
            <label htmlFor="void-note" className="block text-sm font-bold text-surface-dark">
              {noteRequired ? 'وضِّح السبب (مطلوب)' : 'ملاحظة (اختياري)'}
            </label>
            <textarea
              id="void-note"
              rows={2}
              value={note}
              disabled={busy !== null}
              onChange={(e) => setNote(e.target.value)}
              maxLength={VOID_NOTE_MAX_LENGTH}
              placeholder={noteRequired ? 'ما الذي حدث بالضبط؟' : ''}
              className="mt-1.5 w-full rounded-xl border border-surface-sand-border px-3 py-2 text-sm text-surface-dark focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500 disabled:opacity-50"
            />
            {noteRequired && note.trim() === '' && (
              <p className="mt-1 text-xs text-slate-500">
                «سبب آخر» بلا توضيح لا يفيد أحدًا لاحقًا.
              </p>
            )}
          </div>
        )}

        <div className="rounded-xl border border-surface-sand-border bg-surface-sand-alt/50 px-4 py-3">
          <p className="text-sm font-bold text-surface-dark">هل تم تحضير الطعام؟</p>
          <p className="mt-1 text-xs text-slate-500">
            الإجابة تحدّد ما يحدث للمكوّنات المخصومة من المخزون، ولا يمكن تعديلها لاحقًا.
          </p>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            disabled={busy !== null || !ready}
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
            disabled={busy !== null || !ready}
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

        {!ready && (
          <p className="text-xs text-slate-500">
            اختر سبب الإلغاء أولًا لتفعيل الخيارين أعلاه.
          </p>
        )}

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
