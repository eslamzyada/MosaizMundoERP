import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { moduleRepository, planName, type TenantModule } from '../api/ModuleRepository';
import { useSession } from '../session/SessionProvider';

/**
 * Which parts of the system this restaurant runs (0037).
 *
 * The screen where a tenant makes the ERP its own. Two things it deliberately
 * does NOT do:
 *
 *   1. It does not hide switches from people who cannot use them. A branch
 *      manager sees the list, disabled, with the reason — because "why can I
 *      not find الجرد" is answered better by a greyed switch than by an absence.
 *   2. It does not pretend a dependency does not exist. Switching المخزون off
 *      while المشتريات is still on comes back 409 naming the blocker, and that
 *      name is shown as-is.
 *
 * Since 0044 there is a THIRD reason a switch will not move, and it is the one
 * that must never be confused with the other two: the plan does not reach it.
 * A greyed switch that says "ask your owner" when the owner is the one reading
 * it is worse than no explanation. So a capability above the plan is shown,
 * named, and labelled with the tier that would unlock it — visible, because
 * you cannot want what you cannot see, and locked, because it is not included.
 */
export default function ModulesPanel() {
  const { me, reload } = useSession();
  const canDecide = me?.role === 'owner' || me?.role === 'regional_manager';

  const [modules, setModules] = useState<TenantModule[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** The module the owner is being asked about before it is switched off. */
  const [confirming, setConfirming] = useState<TenantModule | null>(null);

  const load = useCallback(async () => {
    try {
      setModules(await moduleRepository.list());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Switching a module OFF is asked about; switching one ON is not.
   *
   * They are not symmetrical acts. Turning something on adds a screen somebody
   * can ignore. Turning it off removes a section of the system from everyone in
   * the restaurant at once — the sidebar changes under people who are mid-task,
   * and the next person to reach for أوامر الشراء finds it gone with no idea
   * why. That deserves a sentence naming what will happen, and it deserves it
   * BEFORE the request, not as an undo afterwards.
   */
  async function requestToggle(mod: TenantModule) {
    if (mod.enabled) {
      setConfirming(mod);
      return;
    }
    await toggle(mod);
  }

  async function toggle(mod: TenantModule) {
    setConfirming(null);
    setBusy(mod.key);
    setProblem(null);
    try {
      await moduleRepository.set(mod.key, !mod.enabled);
      await load();
      // The sidebar is built from /api/me, so it has to be told: switching a
      // module off without this leaves a nav item that answers 409 when clicked.
      reload();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        const body = err.response.data as { blocked_by?: string; error?: string };
        setProblem(
          body.blocked_by
            ? `لا يمكن إيقاف «${mod.name}» بينما «${nameOf(body.blocked_by)}» ما زالت مفعّلة.`
            : (body.error ?? 'تعذّر إجراء هذا التغيير.'),
        );
      } else if (axios.isAxiosError(err) && err.response?.status === 402) {
        // The backstop for a downgrade that lands between this screen loading
        // and the switch being pressed. The button is already disabled for the
        // cases we know about; this covers the one we cannot.
        const body = err.response.data as { required_plan?: string };
        setProblem(
          body.required_plan
            ? `«${mod.name}» غير مشمولة في خطتك الحالية — تحتاج خطة ${planName(body.required_plan)}.`
            : 'هذه الوحدة غير مشمولة في خطتك الحالية.',
        );
      } else if (axios.isAxiosError(err) && err.response?.status === 403) {
        setProblem('تغيير الوحدات من صلاحية المالك أو المدير الإقليمي فقط.');
      } else {
        setProblem('تعذّر إجراء هذا التغيير.');
      }
    } finally {
      setBusy(null);
    }
  }

  const nameOf = (key: string) => modules?.find((m) => m.key === key)?.name ?? key;

  /**
   * Whether the plan holds this switch down.
   *
   * Only on the way ON. A capability above the plan that is somehow running —
   * grandfathered, or switched on before a downgrade — must stay switchable
   * OFF, or a tenant is stuck with a screen they cannot use and cannot clear.
   *
   * An ABSENT `entitled` means no opinion, not "locked". This screen is not
   * the gate — the database is, and the API answers 402 either way. Reading a
   * missing field as a lock would freeze every switch against an older API,
   * which is a broken screen in exchange for a guarantee we already have.
   * Same reading `navFor` gives an absent module list.
   */
  const locked = (mod: TenantModule) =>
    !mod.enabled && mod.entitled === false && !mod.grandfathered;

  if (failed) {
    return (
      <p className="rounded-xl border border-app-border bg-app-surface p-6 text-sm text-app-ink-muted">
        تعذّر تحميل قائمة الوحدات.
      </p>
    );
  }

  return (
    <section
      data-testid="modules-panel"
      className="rounded-xl border border-app-border bg-app-surface p-6"
    >
      <h2 className="text-lg font-bold text-app-ink">وحدات النظام</h2>
      <p className="mt-1 text-sm text-app-ink-muted">
        شغّل ما يخدم مطعمك وأوقف ما لا يخدمه. إيقاف وحدة يمنع العمليات الجديدة فيها،
        ولا يغيّر شيئًا في التقارير عمّا مضى.
      </p>

      {me?.plan && (
        <p
          data-testid="current-plan"
          className="mt-3 inline-block rounded-lg bg-app-bg px-3 py-1.5 text-xs text-app-ink-muted"
        >
          خطة الاشتراك الحالية: <span className="font-semibold text-app-ink">{planName(me.plan)}</span>
        </p>
      )}

      {!canDecide && (
        <p className="mt-3 rounded-lg bg-app-bg px-3 py-2 text-xs text-app-ink-muted">
          هذه إعدادات اشتراك المطعم — يغيّرها المالك أو المدير الإقليمي.
        </p>
      )}

      {problem && (
        <p
          data-testid="module-problem"
          className="mt-3 rounded-lg border border-sunset-300 bg-sunset-50 px-3 py-2 text-xs text-sunset-700"
        >
          {problem}
        </p>
      )}

      {confirming && (
        <div
          data-testid="module-confirm"
          role="alertdialog"
          aria-label={`إيقاف ${confirming.name}`}
          className="mt-4 rounded-lg border border-sunset-300 bg-sunset-50 p-4"
        >
          <p className="text-sm font-semibold text-sunset-900">
            إيقاف «{confirming.name}» لكل من في المطعم؟
          </p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-sunset-800">
            <li>ستختفي من القائمة الجانبية لكل المستخدمين، وتُرفض أي عملية جديدة فيها.</li>
            {/* The promise that makes this reversible without fear. */}
            <li>لن يتغيّر شيء في التقارير عمّا مضى — السجلّ السابق يبقى كما هو.</li>
            <li>يمكنك إعادة تشغيلها من هنا في أي وقت.</li>
          </ul>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => toggle(confirming)}
              className="rounded-lg bg-sunset-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sunset-700"
            >
              إيقاف الوحدة
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="rounded-lg border border-app-border bg-app-surface px-4 py-1.5 text-xs font-semibold text-app-ink"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {(modules ?? []).map((mod) => (
          <li
            key={mod.key}
            data-testid={`module-${mod.key}`}
            className="flex items-start justify-between gap-4 rounded-lg border border-app-border px-4 py-3"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-app-ink">{mod.name}</span>
              <span className="mt-0.5 block text-xs text-app-ink-muted">{mod.description}</span>
              {mod.depends_on.length > 0 && (
                <span className="mt-1 block text-[11px] text-app-ink-muted">
                  تحتاج: {mod.depends_on.map(nameOf).join('، ')}
                </span>
              )}

              {/* Locked by the plan, and by nothing else — this is the label a
                  reader needs in order to know the fix costs money rather than
                  a click. Shown to everyone, not only to whoever may decide. */}
              {!mod.entitled && !mod.grandfathered && (
                <span
                  data-testid={`locked-${mod.key}`}
                  className="mt-1 inline-block rounded bg-sunset-50 px-2 py-0.5 text-[11px] font-medium text-sunset-700"
                >
                  متاحة في خطة {planName(mod.min_plan)}
                </span>
              )}

              {/* On despite the ceiling, because it was on before there were
                  plans. Saying so beats a reader concluding the lock is broken. */}
              {!mod.entitled && mod.grandfathered && (
                <span
                  data-testid={`kept-${mod.key}`}
                  className="mt-1 inline-block rounded bg-app-bg px-2 py-0.5 text-[11px] text-app-ink-muted"
                >
                  محتفظ بها من اشتراكك السابق
                </span>
              )}
            </span>

            <button
              type="button"
              role="switch"
              aria-checked={mod.enabled}
              aria-label={mod.name}
              disabled={!canDecide || busy === mod.key || locked(mod)}
              onClick={() => requestToggle(mod)}
              className={[
                'mt-1 h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500',
                mod.enabled ? 'bg-twilight-600' : 'bg-app-border',
                !canDecide || locked(mod) ? 'cursor-not-allowed opacity-50' : '',
              ].join(' ')}
            >
              <span
                aria-hidden
                className={[
                  'block h-5 w-5 rounded-full bg-white shadow transition-transform',
                  // RTL: "on" sits at the start of the track, which is the right.
                  mod.enabled ? 'translate-x-0.5' : '-translate-x-5',
                ].join(' ')}
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
