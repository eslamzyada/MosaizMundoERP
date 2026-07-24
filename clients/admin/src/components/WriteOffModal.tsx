import { useEffect, useState } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import {
  REASON_REQUIRING_NOTE,
  WRITE_OFF_NOTE_MAX_LENGTH,
  WRITE_OFF_REASONS,
  type WriteOffReasonCode,
} from '../lib/writeOffReasons';
import type { ExpiringLot, WriteOffPayload } from '../types';

interface Props {
  /** The lot being written off, or null when the modal is closed. */
  lot: ExpiringLot | null;
  onClose: () => void;
  onWriteOff: (payload: WriteOffPayload) => Promise<void>;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Discarding stock, with a cause.
 *
 * The reason is a fixed list because the whole value is telling causes apart:
 * 'expired' means over-ordering, 'spoiled' means storage failed, 'prep_error'
 * means training. Free text collapses three different fixes into one
 * uncountable pile.
 *
 * The write-off is always against THIS LOT, not the ingredient in general. That
 * is the point of reaching it from the expiring list — you are binning the
 * crate in front of you, which is not necessarily the one FIFO would pick.
 *
 * The quantity defaults to the whole lot, because that is overwhelmingly what
 * happens with expiry, but it stays editable: sometimes only part of a crate has
 * turned.
 */
export default function WriteOffModal({ lot, onClose, onWriteOff }: Props) {
  const [reason, setReason] = useState<WriteOffReasonCode | null>(null);
  const [note, setNote] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (lot) {
      // Expiry is the common path here, so it is preselected — but only when
      // the lot has actually expired. Guessing 'expired' for a lot that is
      // merely close would put a wrong cause in the report by default.
      setReason(lot.already_expired ? 'expired' : null);
      setNote('');
      setQuantity(String(lot.quantity_remaining));
      setBusy(false);
      setError(null);
    }
  }, [lot]);

  if (!lot) return null;

  const qty = Number(quantity);
  const qtyValid = Number.isFinite(qty) && qty > 0;
  const noteRequired = reason === REASON_REQUIRING_NOTE;
  const noteTooLong = note.trim().length > WRITE_OFF_NOTE_MAX_LENGTH;
  const ready =
    reason !== null && qtyValid && (!noteRequired || note.trim() !== '') && !noteTooLong;

  async function submit() {
    if (!lot || !reason || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await onWriteOff({
        raw_item_id: lot.raw_item_id,
        batch_id: lot.batch_id,
        quantity: qty,
        reason,
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      onClose();
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      setError(msg ?? 'تعذّر تسجيل الإتلاف. حاول مرة أخرى.');
      setBusy(false);
    }
  }

  return (
    <Modal open title="إتلاف مخزون" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-xl border border-surface-sand-border bg-surface-sand-alt/50 px-4 py-3">
          <p className="text-sm font-bold text-surface-dark">{lot.item_name}</p>
          <p className="mt-1 text-xs text-slate-500">
            المتبقٍ في هذه الدفعة{' '}
            <span className="font-numerals font-semibold">{lot.quantity_remaining}</span>{' '}
            {lot.unit_of_measure} — بقيمة{' '}
            <span className="font-numerals font-semibold">{money(lot.value_at_risk)}</span> ج.م
          </p>
          {lot.already_expired && (
            <p className="mt-1 text-xs font-semibold text-destructive-strong">
              انتهت صلاحيتها منذ{' '}
              <span className="font-numerals">{Math.abs(lot.days_left)}</span> يومًا.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="wo-qty" className="block text-sm font-bold text-surface-dark">
            الكمية المُتلَفة
          </label>
          <input
            id="wo-qty"
            type="number"
            min="0"
            step="any"
            value={quantity}
            disabled={busy}
            onChange={(e) => setQuantity(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-surface-sand-border px-3 py-2 font-numerals text-sm text-surface-dark focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-slate-500">
            إن تجاوزت المتبقٍ في الدفاتر، يُسجَّل الفارق كعجز يُسوّى في الجرد.
          </p>
        </div>

        <fieldset>
          <legend className="text-sm font-bold text-surface-dark">ما سبب الإتلاف؟</legend>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {WRITE_OFF_REASONS.map((r) => {
              const selected = reason === r.code;
              return (
                <label
                  key={r.code}
                  className={`cursor-pointer rounded-xl border px-3 py-2 transition-colors ${
                    selected
                      ? 'border-twilight-500 bg-twilight-100/50'
                      : 'border-surface-sand-border bg-white hover:border-twilight-500/50'
                  } ${busy ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <input
                    type="radio"
                    name="write_off_reason"
                    value={r.code}
                    checked={selected}
                    disabled={busy}
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
            <label htmlFor="wo-note" className="block text-sm font-bold text-surface-dark">
              {noteRequired ? 'وضِّح السبب (مطلوب)' : 'ملاحظة (اختياري)'}
            </label>
            <textarea
              id="wo-note"
              rows={2}
              value={note}
              disabled={busy}
              maxLength={WRITE_OFF_NOTE_MAX_LENGTH}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-surface-sand-border px-3 py-2 text-sm text-surface-dark focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500 disabled:opacity-50"
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs font-semibold text-destructive-strong">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            تراجع
          </Button>
          <Button type="button" onClick={submit} disabled={!ready || busy}>
            {busy ? 'جارٍ التسجيل…' : 'تسجيل الإتلاف'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
