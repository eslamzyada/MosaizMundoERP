import { useCallback, useEffect, useState } from 'react';
import { ratingCriteriaRepository } from '../api/RatingCriteriaRepository';
import type { CriterionScore, RatingCriterion } from '../api/RatingCriteriaRepository';
import { classifyLoadFailure } from '../lib/loadFailure';

/**
 * Scoring one person against the rubric, for the current month.
 *
 * Deliberately does NOT touch the overall rating beside it. A manager who marks
 * every criterion a 5 and still thinks somebody is struggling is saying
 * something real, and the two figures are shown together precisely so that
 * disagreement is visible rather than averaged away.
 *
 * Only the current month is writable, which is the database's rule (0027's
 * trigger, reused by 0033) rather than this component's. Past months are shown
 * read-only rather than hidden: last month's scores are the reason this month's
 * conversation is happening.
 */

export default function CriterionScoreSheet({
  employeeId,
  employeeLabel,
  canScore,
}: {
  employeeId: string;
  employeeLabel: string;
  canScore: boolean;
}) {
  const [criteria, setCriteria] = useState<RatingCriterion[]>([]);
  const [scores, setScores] = useState<Map<string, CriterionScore>>(new Map());
  const [average, setAverage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([ratingCriteriaRepository.list(), ratingCriteriaRepository.scores()])
      .then(([list, response]) => {
        setCriteria(list);
        const mine = response.employees.find((e) => e.employee_id === employeeId);
        setScores(new Map((mine?.scores ?? []).map((s) => [s.criterion_id, s])));
        setAverage(mine?.weighted_average ?? null);
        setError(null);
      })
      .catch((err) => setError(classifyLoadFailure(err).message))
      .finally(() => setLoading(false));
  }, [employeeId]);

  useEffect(load, [load]);

  async function give(criterionId: string, score: number) {
    setBusy(criterionId);
    setError(null);
    try {
      await ratingCriteriaRepository.score(employeeId, criterionId, score);
      load();
    } catch (err) {
      const fromServer = (err as { response?: { data?: { error?: string } } })?.response?.data
        ?.error;
      setError(fromServer ?? classifyLoadFailure(err).message);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <p className="px-6 py-4 text-sm text-app-ink-muted">جارٍ التحميل…</p>;
  }

  if (criteria.length === 0) {
    return (
      <p className="px-6 py-4 text-sm text-app-ink-muted">
        لا توجد معايير بعد. تُضاف من صفحة الإعدادات.
      </p>
    );
  }

  return (
    <div className="px-6 py-4" data-testid={`score-sheet-${employeeId}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-xs font-semibold text-app-ink-muted">
          تقييم <span className="text-app-ink">{employeeLabel}</span> على المعايير — هذا الشهر
        </p>
        {average !== null && (
          <p className="text-xs text-app-ink-muted">
            المتوسط المرجّح:{' '}
            <span className="font-numerals text-sm font-bold text-app-ink">{average}</span>
            {' '}من ٥
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-3 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}

      <ul className="space-y-2">
        {criteria.map((criterion) => {
          const given = scores.get(criterion.id);
          return (
            <li
              key={criterion.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-app-border p-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm text-app-ink">
                  {criterion.name}
                  {criterion.weight !== 1 && (
                    <span className="ms-1.5 font-numerals text-xs text-app-ink-muted">
                      ×{criterion.weight}
                    </span>
                  )}
                </p>
                {criterion.description && (
                  <p className="text-xs text-app-ink-muted">{criterion.description}</p>
                )}
              </div>

              <div className="flex flex-shrink-0 gap-1" role="group" aria-label={criterion.name}>
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={!canScore || busy !== null}
                    aria-pressed={given?.score === value}
                    aria-label={`${criterion.name}: ${value}`}
                    onClick={() => void give(criterion.id, value)}
                    className={`h-8 w-8 rounded-lg border font-numerals text-sm font-semibold transition-colors disabled:opacity-50 ${
                      given?.score === value
                        ? 'border-twilight-600 bg-twilight-600 text-white'
                        : 'border-app-border text-app-ink hover:bg-app-surface-alt'
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      {!canScore && (
        <p className="mt-3 text-xs text-app-ink-muted">التقييم من صلاحيات المديرين.</p>
      )}
    </div>
  );
}
