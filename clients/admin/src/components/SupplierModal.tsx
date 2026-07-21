import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import type { Supplier } from '../types';

interface Props {
  open: boolean;
  /** The supplier being edited, or null to add a new one. */
  supplier: Supplier | null;
  onClose: () => void;
  onSave: (payload: {
    name: string;
    contact_name: string | null;
    phone: string | null;
    notes: string | null;
  }) => Promise<void>;
}

const inputClass =
  'w-full rounded-lg border border-surface-sand-border bg-white px-3 py-2 text-sm text-surface-dark ' +
  'focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30';

/**
 * Add or edit a supplier. Only the name is required — a corner-shop supplier
 * may be a phone number and nothing else, and demanding structured details
 * would push people into typing junk to get past the form.
 */
export default function SupplierModal({ open, supplier, onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(supplier?.name ?? '');
      setContact(supplier?.contact_name ?? '');
      setPhone(supplier?.phone ?? '');
      setNotes(supplier?.notes ?? '');
      setSaving(false);
      setError(null);
    }
  }, [open, supplier]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('أدخل اسم المورّد.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmed,
        contact_name: contact.trim() || null,
        phone: phone.trim() || null,
        notes: notes.trim() || null,
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
    <Modal open={open} title={supplier ? 'تعديل المورّد' : 'إضافة مورّد'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="اسم المورّد">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="مثال: أسواق القاهرة للأغذية"
            className={inputClass}
          />
        </Field>

        <Field label="مسؤول التواصل (اختياري)">
          <input
            type="text"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="مثال: أحمد"
            className={inputClass}
          />
        </Field>

        <Field label="رقم الهاتف (اختياري)">
          <input
            type="text"
            dir="ltr"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+20 100 000 0000"
            className={`${inputClass} text-start`}
          />
        </Field>

        <Field label="ملاحظات (اختياري)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="مواعيد التوريد، شروط الدفع…"
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
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? 'جارٍ الحفظ…' : supplier ? 'حفظ التغييرات' : 'إضافة'}
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
