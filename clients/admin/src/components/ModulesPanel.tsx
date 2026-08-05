import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { moduleRepository, type TenantModule } from '../api/ModuleRepository';
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
 */
export default function ModulesPanel() {
  const { me, reload } = useSession();
  const canDecide = me?.role === 'owner' || me?.role === 'regional_manager';

  const [modules, setModules] = useState<TenantModule[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

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

  async function toggle(mod: TenantModule) {
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
            </span>

            <button
              type="button"
              role="switch"
              aria-checked={mod.enabled}
              aria-label={mod.name}
              disabled={!canDecide || busy === mod.key}
              onClick={() => toggle(mod)}
              className={[
                'mt-1 h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500',
                mod.enabled ? 'bg-twilight-600' : 'bg-app-border',
                !canDecide ? 'cursor-not-allowed opacity-50' : '',
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
