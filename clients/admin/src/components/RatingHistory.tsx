import { useMemo } from 'react';
import type { EmployeeRating } from '../types';

/**
 * Employee ratings over time.
 *
 * Until now a rating could be RECORDED and never SEEN: the table showed one
 * star control for the current month and threw the rest of the history away,
 * even though the API had already returned it. A manager could rate someone
 * every month for a year and have no way to notice they had been sliding since
 * spring — which is the only question a rating is actually for.
 *
 * Drawn as inline SVG rather than pulling in a charting library: the admin
 * already draws its own marks this way, and a dependency for eight bars would
 * be the largest thing in the bundle.
 *
 * NOT AVERAGED WITH ANYTHING. A rating is a manager's opinion and sits beside
 * the measured figures, never blended into them — combining a fact and a
 * judgement into one score hides which of the two produced it.
 */

const BAR_W = 14;
const GAP = 5;
const CHART_H = 44;

/** YYYY-MM for the last [count] months, oldest first. */
function recentMonths(count: number): string[] {
  const out: string[] = [];
  const cursor = new Date();
  cursor.setDate(1);
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(cursor);
    d.setMonth(d.getMonth() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const TONE: Record<number, string> = {
  1: '#dc2626',
  2: '#ea580c',
  3: '#ca8a04',
  4: '#65a30d',
  5: '#16a34a',
};

/**
 * One employee's last [months] ratings.
 *
 * A month with no rating is drawn as an empty slot, not skipped. Closing the
 * gap would turn "we forgot to rate them in March" into a continuous line and
 * quietly invent a history that never happened.
 */
export function RatingSparkline({
  ratings,
  months = 12,
}: {
  ratings: EmployeeRating[];
  months?: number;
}) {
  const scale = useMemo(() => {
    const byMonth = new Map(ratings.map((r) => [r.period_month.slice(0, 7), r.score]));
    return recentMonths(months).map((m) => ({ month: m, score: byMonth.get(m) ?? null }));
  }, [ratings, months]);

  const rated = scale.filter((s) => s.score !== null);
  if (rated.length === 0) {
    return <span className="text-xs text-app-ink-muted">لا يوجد تقييم بعد</span>;
  }

  const width = scale.length * (BAR_W + GAP);

  return (
    <div className="flex items-end gap-2">
      <svg
        width={width}
        height={CHART_H}
        viewBox={`0 0 ${width} ${CHART_H}`}
        role="img"
        aria-label={`تقييمات آخر ${scale.length} شهرًا`}
      >
        {scale.map((slot, i) => {
          const x = i * (BAR_W + GAP);
          if (slot.score === null) {
            // An un-rated month: a faint baseline, so the gap is visible as a
            // gap rather than passing for a low score.
            return (
              <rect
                key={slot.month}
                x={x}
                y={CHART_H - 2}
                width={BAR_W}
                height={2}
                rx={1}
                fill="#e2e8f0"
              />
            );
          }
          const h = Math.round((slot.score / 5) * (CHART_H - 4)) + 2;
          return (
            <rect
              key={slot.month}
              x={x}
              y={CHART_H - h}
              width={BAR_W}
              height={h}
              rx={2}
              fill={TONE[slot.score] ?? '#94a3b8'}
            >
              <title>{`${slot.month}: ${slot.score}/5`}</title>
            </rect>
          );
        })}
      </svg>
      <Trend scale={scale} />
    </div>
  );
}

/**
 * Which way it is going.
 *
 * Compares the most recent rating with the one before it — the comparison a
 * manager makes in their head anyway. Deliberately not a regression over the
 * whole window: with three or four data points a slope is noise dressed up as
 * arithmetic.
 */
function Trend({ scale }: { scale: { month: string; score: number | null }[] }) {
  const rated = scale.filter((s) => s.score !== null) as { month: string; score: number }[];
  if (rated.length < 2) return null;

  const latest = rated[rated.length - 1].score;
  const previous = rated[rated.length - 2].score;
  const delta = latest - previous;
  if (delta === 0) {
    return <span className="text-xs text-app-ink-muted" title="بلا تغيّر عن التقييم السابق">→</span>;
  }
  return (
    <span
      className={`text-xs font-semibold ${delta > 0 ? 'text-green-600' : 'text-red-600'}`}
      title={`${delta > 0 ? 'أعلى' : 'أقل'} بمقدار ${Math.abs(delta)} عن التقييم السابق`}
    >
      {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}
    </span>
  );
}

/**
 * The team's average rating, month by month.
 *
 * Averaging PEOPLE within a month is fair — they were all rated against the
 * same period by the same manager. (Averaging a rating with someone's sales
 * figures would not be, which is why that never happens anywhere here.)
 *
 * Months where nobody was rated are drawn as gaps in the line, for the same
 * reason the bars leave holes: a line through them would assert a continuity
 * that does not exist.
 */
export function TeamRatingTrend({
  ratings,
  months = 12,
}: {
  ratings: EmployeeRating[];
  months?: number;
}) {
  const points = useMemo(() => {
    const buckets = new Map<string, number[]>();
    for (const r of ratings) {
      const m = r.period_month.slice(0, 7);
      buckets.set(m, [...(buckets.get(m) ?? []), r.score]);
    }
    return recentMonths(months).map((m) => {
      const scores = buckets.get(m);
      return {
        month: m,
        average: scores && scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : null,
        count: scores?.length ?? 0,
      };
    });
  }, [ratings, months]);

  const rated = points.filter((p) => p.average !== null);
  if (rated.length === 0) return null;

  const W = 560;
  const H = 120;
  const PAD = 28;
  const stepX = (W - PAD * 2) / Math.max(points.length - 1, 1);
  const yFor = (v: number) => H - PAD - ((v - 1) / 4) * (H - PAD * 2);

  // Broken into runs so a month nobody rated leaves a gap rather than a line
  // drawn straight through it.
  const runs: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.average === null) {
      if (current.length > 1) runs.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${PAD + i * stepX},${yFor(p.average)}`);
  });
  if (current.length > 1) runs.push(current.join(' '));

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="متوسط تقييم الفريق شهريًا">
        {[1, 3, 5].map((v) => (
          <g key={v}>
            <line
              x1={PAD}
              x2={W - PAD}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            <text x={4} y={yFor(v) + 4} fontSize={10} fill="#94a3b8">
              {v}
            </text>
          </g>
        ))}

        {runs.map((run) => (
          <polyline key={run} points={run} fill="none" stroke="#6930bd" strokeWidth={2} />
        ))}

        {points.map((p, i) =>
          p.average === null ? null : (
            <circle key={p.month} cx={PAD + i * stepX} cy={yFor(p.average)} r={3} fill="#6930bd">
              <title>{`${p.month}: ${p.average.toFixed(2)} — ${p.count} موظف`}</title>
            </circle>
          ),
        )}

        {/* Only the ends are labelled: twelve rotated month labels on a chart
            this size are unreadable, and the tooltips carry the rest. */}
        <text x={PAD} y={H - 6} fontSize={10} fill="#94a3b8">
          {points[0]?.month}
        </text>
        <text x={W - PAD} y={H - 6} fontSize={10} fill="#94a3b8" textAnchor="end">
          {points[points.length - 1]?.month}
        </text>
      </svg>
    </div>
  );
}
