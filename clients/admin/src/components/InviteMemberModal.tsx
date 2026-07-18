import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import axios from 'axios';
import Modal from './ui/Modal';
import Button from './Button';
import { ROLE_LABELS } from '../session/SessionProvider';
import { ROLES } from '../types';
import type { Role } from '../types';

interface Props {
  open: boolean;
  /** The caller's own role — only an owner may hand out 'owner'. */
  currentUserRole: Role | null;
  onClose: () => void;
  onInvite: (email: string, role: Role) => Promise<void>;
}

const inputClass =
  'w-full rounded-lg border border-surface-sand-border bg-white px-3 py-2 text-sm text-surface-dark ' +
  'focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30';

export default function InviteMemberModal({ open, currentUserRole, onClose, onInvite }: Props) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail('');
      setRole('cashier');
      setSaving(false);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed.includes('@')) {
      setError('أدخل بريدًا إلكترونيًا صحيحًا.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onInvite(trimmed, role);
      onClose();
    } catch (err) {
      // The API words its refusals for humans ("already a member", duplicate
      // invite) — prefer its message over a generic one.
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;
      setError(msg ?? 'تعذّر إرسال الدعوة. حاول مرة أخرى.');
      setSaving(false);
    }
  }

  return (
    <Modal open={open} title="دعوة عضو" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="البريد الإلكتروني">
          <input
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="name@example.com"
            autoComplete="off"
            className={`${inputClass} text-start`}
          />
        </Field>

        <Field label="الدور">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className={inputClass}
          >
            {ROLES.map((r) => (
              <option key={r} value={r} disabled={r === 'owner' && currentUserRole !== 'owner'}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>

        <p className="text-xs text-slate-500">
          ينضم المدعوّ إلى مؤسستك عند إنشاء حسابه بهذا البريد.
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
            {saving ? 'جارٍ الإرسال…' : 'إرسال الدعوة'}
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
