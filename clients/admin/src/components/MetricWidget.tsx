import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Accent = 'sunset' | 'twilight' | 'amber';

const ACCENT: Record<Accent, { bar: string; icon: string }> = {
  sunset: { bar: 'bg-sunset-500', icon: 'bg-sunset-50 text-sunset-600' },
  twilight: { bar: 'bg-twilight-500', icon: 'bg-twilight-50 text-twilight-600' },
  amber: { bar: 'bg-amber-500', icon: 'bg-amber-50 text-amber-600' },
};

interface MetricWidgetProps {
  label: string;
  value: string;
  /**
   * Where this number is explained.
   *
   * Every metric was a dead end: "نواقص المخزون: 3" and no way to reach the
   * three. A figure on a dashboard is a question — the page that answers it
   * should be one tap away, not a hunt through the sidebar.
   *
   * Optional, and the caller is expected to pass it only when the ROLE may
   * open that page: a link that bounces off the route guard is worse than no
   * link, because it looks like the app is broken rather than like the page
   * is not theirs.
   */
  to?: string;
  /**
   * Change against the previous window of the same length, as a fraction
   * (0.12 = twelve per cent up). Null when there is nothing to compare with —
   * a first day, or a window with no orders before it.
   */
  delta?: number | null;
  /** Optional unit shown after the value (e.g. a currency), in Cairo. */
  suffix?: string;
  accent: Accent;
  icon: ReactNode;
  loading?: boolean;
}

export default function MetricWidget({
  label,
  value,
  suffix,
  accent,
  icon,
  loading = false,
  to,
  delta,
}: MetricWidgetProps) {
  const a = ACCENT[accent];

  const body = (
    <>
      <span className={`absolute inset-y-0 end-0 w-1 ${a.bar}`} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-app-ink-muted">
            {label}
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="font-numerals text-3xl font-bold text-app-ink">
              {loading ? '—' : value}
            </span>
            {suffix && !loading ? (
              <span className="text-sm font-medium text-app-ink-muted">{suffix}</span>
            ) : null}
          </div>
        </div>
        <span className={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl ${a.icon}`}>
          {icon}
        </span>
      </div>
    </>
  );

  const card =
    'relative block overflow-hidden rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm';

  const inner = (
    <>
      <span className={`absolute inset-y-0 end-0 w-1 ${a.bar}`} aria-hidden />
      {body}
      {!loading && delta !== undefined && delta !== null ? <Delta value={delta} /> : null}
    </>
  );

  // A link when there is somewhere to go, a plain card otherwise — rather than
  // a card with a click handler, so it is reachable by keyboard and announces
  // itself as a link without any extra wiring.
  return to ? (
    <Link
      to={to}
      className={`${card} transition-colors hover:bg-app-surface-alt focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500`}
    >
      {inner}
    </Link>
  ) : (
    <div className={card}>{inner}</div>
  );
}

/**
 * The change against the previous window.
 *
 * Shown as a percentage AND with a direction word, never by colour alone:
 * red-is-bad is invisible to a colourblind manager and meaningless on a metric
 * where up is bad — stock shortages rising is not good news in green.
 */
function Delta({ value }: { value: number }) {
  const pct = Math.abs(value * 100);
  const up = value > 0;
  const flat = Math.abs(value) < 0.005;

  return (
    <div className="mt-3 text-xs font-semibold text-app-ink-muted">
      {flat ? (
        'كما في الفترة السابقة'
      ) : (
        <span className="font-numerals">
          {up ? '▲' : '▼'} {pct.toFixed(pct < 10 ? 1 : 0)}%{' '}
          <span className="font-sans font-medium">عن الفترة السابقة</span>
        </span>
      )}
    </div>
  );
}
