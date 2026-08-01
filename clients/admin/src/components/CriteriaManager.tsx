import { useCallback, useEffect, useState } from 'react';
import { ratingCriteriaRepository } from '../api/RatingCriteriaRepository';
import type { RatingCriterion } from '../api/RatingCriteriaRepository';
import { classifyLoadFailure } from '../lib/loadFailure';

/**
 * The review rubric — what this restaurant assesses its people on.
 *
 * Organisation-wide, so it is gated and says so. Everyone may READ the list,
 * which is deliberate: a standard nobody is allowed to see is a standard nobody
 * can be expected to meet, and staff being told what they are judged on is the
 * point of having criteria at all.
 *
 * RETIRE, NOT DELETE, once a criterion has been used. The server refuses the
 * delete and explains why; this offers retirement as the obvious next move
 * rather than leaving somebody to work out what a foreign key is.
 */

const WEIGHT_HINT = 'كم يزن هذا المعيار في المتوسط المرجّح. الافتراضي ١';

export default function CriteriaManager({ canManage }: { canManage: boolean }) {
  const [criteria, setCriteria] = useState<RatingCriterion[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [weight, setWeight] = useState('1');

  const load = useCallback(() => {
    setLoading(true);
    ratingCriteriaRepository
      // Retired ones are shown here and nowhere else: this is the only screen
      // from which one can be brought back.
      .list(true)
      .then((rows) => {
        setCriteria(rows);
        setFailed(false);
      })
      .catch((err) => {
        setFailed(true);
        setMessage(classifyLoadFailure(err).message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      await action();
      setMessage(success);
      load();
    } catch (err) {
      setFailed(true);
      // The server's wording is the specific one — it knows whether the name
      // collides or the criterion has already been used in a review.
      const fromServer = (err as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      setMessage(fromServer ?? classifyLoadFailure(err).message);
    } finally {
      setBusy(false);
    }
  }

  const active = criteria.filter((c) => c.is_active);
  const retired = criteria.filter((c) => !c.is_active);

  return (
    <section className="rounded-xl border border-app-border bg-app-surface p-6 shadow-sm lg:col-span-2">
      <h2 className="text-lg font-semibold text-app-ink">معايير تقييم الموظفين</h2>
      <p className="mt-1 text-sm text-app-ink-muted">
        ما يُقيَّم عليه الفريق. يراها كل الموظفين — المعيار الذي لا يعرفه أحد لا يمكن الالتزام
        به — ويعدّلها المديرون وحدهم.
      </p>

      {message && (
        <div
          role="alert"
          className={`mt-4 rounded-lg border p-3 text-sm ${
            failed
              ? 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200'
          }`}
        >
          {message}
        </div>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-app-ink-muted">جارٍ التحميل…</p>
      ) : (
        <>
          <ul className="mt-4 space-y-2">
            {active.map((criterion) => (
              <li
                key={criterion.id}
                data-testid={`criterion-${criterion.id}`}
                className="rounded-lg border border-app-border p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-app-ink">{criterion.name}</p>
                    {criterion.description && (
                      <p className="mt-0.5 text-xs text-app-ink-muted">{criterion.description}</p>
                    )}
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-2">
                    <span
                      className="rounded-md bg-app-surface-alt px-2 py-0.5 font-numerals text-xs font-semibold text-app-ink-muted"
                      title={WEIGHT_HINT}
                    >
                      ×{criterion.weight}
                    </span>
                    {canManage && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => ratingCriteriaRepository.update(criterion.id, { is_active: false }),
                              `تم إيقاف «${criterion.name}» — سجلّه محفوظ`,
                            )
                          }
                          className="rounded-lg border border-app-border px-2.5 py-1 text-xs font-semibold text-app-ink transition-colors hover:bg-app-surface-alt disabled:opacity-50"
                        >
                          إيقاف
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => ratingCriteriaRepository.remove(criterion.id),
                              `تم حذف «${criterion.name}»`,
                            )
                          }
                          className="rounded-lg px-2.5 py-1 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                        >
                          حذف
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {retired.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-app-ink-muted">
                معايير موقوفة ({retired.length})
              </summary>
              <ul className="mt-2 space-y-2">
                {retired.map((criterion) => (
                  <li
                    key={criterion.id}
                    data-testid={`criterion-${criterion.id}`}
                    className="flex items-center justify-between rounded-lg border border-dashed border-app-border p-3 opacity-70"
                  >
                    <span className="text-sm text-app-ink">{criterion.name}</span>
                    {canManage && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => ratingCriteriaRepository.update(criterion.id, { is_active: true }),
                            `تمت إعادة «${criterion.name}»`,
                          )
                        }
                        className="rounded-lg border border-app-border px-2.5 py-1 text-xs font-semibold text-app-ink transition-colors hover:bg-app-surface-alt disabled:opacity-50"
                      >
                        إعادة
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {canManage ? (
            <form
              className="mt-5 grid gap-3 rounded-lg border border-dashed border-app-border p-4 sm:grid-cols-[2fr_2fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () =>
                    ratingCriteriaRepository.create({
                      name,
                      description: description || null,
                      weight: Number(weight) || 1,
                      sort_order: active.length + 1,
                    }),
                  `تمت إضافة «${name.trim()}»`,
                ).then(() => {
                  setName('');
                  setDescription('');
                  setWeight('1');
                });
              }}
            >
              <label className="text-xs font-semibold text-app-ink-muted">
                المعيار
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="مثال: إتقان تحضير المشاوي"
                  className="mt-1 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm font-normal text-app-ink"
                />
              </label>
              <label className="text-xs font-semibold text-app-ink-muted">
                الوصف (اختياري)
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  placeholder="ما الذي يعنيه ٥ من ٥"
                  className="mt-1 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm font-normal text-app-ink"
                />
              </label>
              <label className="text-xs font-semibold text-app-ink-muted">
                الوزن
                <input
                  type="number"
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                  min={0.5}
                  max={10}
                  step={0.5}
                  title={WEIGHT_HINT}
                  className="mt-1 w-20 rounded-lg border border-app-border bg-app-surface px-3 py-2 font-numerals text-sm font-normal text-app-ink"
                />
              </label>
              <button
                type="submit"
                disabled={busy || name.trim().length === 0}
                className="rounded-lg bg-twilight-600 px-4 py-2 text-sm font-semibold text-white hover:bg-twilight-700 disabled:opacity-50 sm:col-span-3 sm:justify-self-start"
              >
                إضافة معيار
              </button>
            </form>
          ) : (
            <p className="mt-4 text-sm text-app-ink-muted">
              تعديل المعايير من صلاحيات المديرين.
            </p>
          )}
        </>
      )}
    </section>
  );
}
