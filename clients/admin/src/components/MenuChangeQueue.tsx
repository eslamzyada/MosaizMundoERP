import { useCallback, useEffect, useState } from 'react';
import { menuChangeRepository } from '../api/MenuChangeRepository';
import type { MenuChange, MenuChangeSnapshot } from '../api/MenuChangeRepository';
import { classifyLoadFailure } from '../lib/loadFailure';

/**
 * What is waiting to change on the menu.
 *
 * Shown to EVERYONE, which is deliberate. A waiter quoting tonight's price
 * should be able to see that it is about to move, and the 0035 policies leave
 * SELECT open for exactly that reason. Only the buttons are gated.
 *
 * Every row is a before/after rather than a description. "Price: 85 → 95" is
 * the whole decision; a sentence saying "a price change was requested" makes
 * somebody open a second screen to find out what they are agreeing to.
 */

const KIND_LABEL: Record<string, string> = {
  create: 'صنف جديد',
  update: 'تعديل',
  retire: 'إيقاف',
};

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One line of the diff, or nothing when this field is not being changed. */
function Change({
  label,
  from,
  to,
}: {
  label: string;
  from: string | number | null | undefined;
  to: string | number | null | undefined;
}) {
  // Null in `to` means "leave this alone" — not "clear it". Rendering those as
  // an arrow into an empty box would show a change nobody proposed.
  if (to === null || to === undefined || to === '') return null;
  const same = from !== null && from !== undefined && String(from) === String(to);
  if (same) return null;

  return (
    <p className="text-sm">
      <span className="text-app-ink-muted">{label}: </span>
      {from !== null && from !== undefined && (
        <>
          <span className="font-numerals text-app-ink-muted line-through">{from}</span>
          <span className="mx-1.5 text-app-ink-muted">←</span>
        </>
      )}
      <span className="font-numerals font-semibold text-app-ink">{to}</span>
    </p>
  );
}

function Diff({ change }: { change: MenuChange }) {
  const current: MenuChangeSnapshot = change.current ?? { name: null, sku: null, price: null };

  if (change.kind === 'retire') {
    return (
      <p className="text-sm text-app-ink">
        إيقاف <span className="font-semibold">{current.name ?? '—'}</span> عن القائمة. لن يظهر في
        نقطة البيع، ويبقى في السجلّات.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      <Change label="الاسم" from={current.name} to={change.proposed.name} />
      <Change label="الكود" from={current.sku} to={change.proposed.sku} />
      <Change
        label="السعر"
        from={current.price === null ? null : money(current.price)}
        to={change.proposed.price === null ? null : money(change.proposed.price)}
      />
    </div>
  );
}

export default function MenuChangeQueue({
  canDecide,
  currentUserId,
  onApplied,
}: {
  /** Owner or regional manager. The database decides; this only hides buttons. */
  canDecide: boolean;
  currentUserId: string | null;
  /** Called after a decision, so the menu above can refetch. */
  onApplied: () => void;
}) {
  const [changes, setChanges] = useState<MenuChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    menuChangeRepository
      .list('pending')
      .then((rows) => {
        setChanges(rows);
        setFailed(false);
      })
      .catch((err) => {
        setFailed(true);
        setMessage(classifyLoadFailure(err).message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function run(id: string, action: () => Promise<void>, success: string) {
    setBusy(id);
    setMessage(null);
    setFailed(false);
    try {
      await action();
      setMessage(success);
      load();
      onApplied();
    } catch (err) {
      setFailed(true);
      // The server's wording is the specific one — it knows whether this is
      // "your role cannot decide" or "you proposed it", which have different
      // fixes.
      const fromServer = (err as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      setMessage(fromServer ?? classifyLoadFailure(err).message);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <p className="mt-6 text-sm text-app-ink-muted">جارٍ تحميل الطلبات…</p>;
  }

  if (changes.length === 0 && !message) {
    return null;
  }

  return (
    <section className="mt-6 rounded-2xl border border-app-border bg-app-surface p-6 shadow-sm">
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-app-ink">
          تغييرات بانتظار الاعتماد
          {changes.length > 0 && (
            <span className="ms-2 rounded-md bg-sunset-500/15 px-2 py-0.5 font-numerals text-sm text-sunset-700 dark:text-sunset-300">
              {changes.length}
            </span>
          )}
        </h2>
        <p className="mt-1 text-sm text-app-ink-muted">
          القائمة لا تتغيّر إلا بموافقة المالك أو المدير الإقليمي، ولا يعتمد أحد طلبه بنفسه.
        </p>
      </header>

      {message && (
        <div
          role="alert"
          className={`mb-4 rounded-lg border p-3 text-sm ${
            failed
              ? 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200'
          }`}
        >
          {message}
        </div>
      )}

      <ul className="space-y-3">
        {changes.map((change) => {
          const mine = currentUserId !== null && change.requested_by === currentUserId;
          return (
            <li
              key={change.id}
              data-testid={`change-${change.id}`}
              className="rounded-lg border border-app-border p-4"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-app-surface-alt px-2 py-0.5 text-xs font-semibold text-app-ink-muted">
                  {KIND_LABEL[change.kind] ?? change.kind}
                </span>
                <span className="font-numerals text-xs text-app-ink-muted">
                  {change.requested_at.slice(0, 10)}
                </span>
                {mine && (
                  <span className="text-xs text-app-ink-muted">— طلبك أنت</span>
                )}
              </div>

              <Diff change={change} />

              <p className="mt-2 border-s-2 border-app-border ps-3 text-sm text-app-ink-muted">
                {change.reason}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {canDecide && !mine && (
                  <>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(
                          change.id,
                          () => menuChangeRepository.decide(change.id, true),
                          'تم الاعتماد، وطُبّق التغيير على القائمة',
                        )
                      }
                      className="rounded-lg bg-twilight-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-twilight-700 disabled:opacity-50"
                    >
                      اعتماد
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(
                          change.id,
                          () => menuChangeRepository.decide(change.id, false),
                          'تم رفض الطلب',
                        )
                      }
                      className="rounded-lg border border-app-border px-3 py-1.5 text-sm font-semibold text-app-ink hover:bg-app-surface-alt disabled:opacity-50"
                    >
                      رفض
                    </button>
                  </>
                )}

                {/* Said rather than shown as a disabled button: the reason a
                    decider cannot act on their own request is worth a sentence,
                    because the fix is to ask a colleague. */}
                {canDecide && mine && (
                  <p className="text-xs text-app-ink-muted">
                    لا يعتمد أحد طلبه بنفسه — يحتاج موافقة مالك أو مدير إقليمي آخر.
                  </p>
                )}

                {mine && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        change.id,
                        () => menuChangeRepository.withdraw(change.id),
                        'تم سحب الطلب',
                      )
                    }
                    className="rounded-lg px-3 py-1.5 text-sm font-semibold text-app-ink-muted hover:bg-app-surface-alt disabled:opacity-50"
                  >
                    سحب الطلب
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
