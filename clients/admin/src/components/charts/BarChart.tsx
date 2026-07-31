import { toneColor } from './ChartCard';
import type { Tone } from './ChartCard';

/**
 * A ranked comparison — top suppliers, worst waste, busiest staff.
 *
 * Horizontal, and built from HTML rather than SVG. Arabic labels are long and
 * proportional; in SVG they cannot be truncated, wrapped or given a tooltip
 * without measuring text by hand. As HTML the label is just text that
 * `truncate` handles, and each row can carry its own accessible description.
 *
 * Bars are measured against the LARGEST value, and the track always starts at
 * zero. A bar chart whose axis starts at the smallest value draws 90 as half of
 * 100 — the picture disagrees with the number printed beside it, and the number
 * is the one nobody re-reads.
 */

export interface Bar {
  id: string;
  label: string;
  value: number;
  /** Shown to the right of the bar; the raw figure, already formatted. */
  display: string;
  /** A second line under the label — a unit, a supplier, a share. */
  hint?: string;
  tone?: Tone;
}

export default function BarChart({
  bars,
  tone = 1,
  ariaLabel,
  onSelect,
}: {
  bars: Bar[];
  tone?: Tone;
  ariaLabel: string;
  /** Makes a row clickable — used to jump to the record it describes. */
  onSelect?: (bar: Bar) => void;
}) {
  // Negatives cannot be drawn on a zero-anchored track without inverting it,
  // and none of the things ranked here can legitimately be negative. They are
  // clamped for the WIDTH only — the figure beside the bar is still the real
  // one, so a wrong number shows up as a mismatch rather than vanishing.
  const largest = Math.max(0, ...bars.map((b) => (Number.isFinite(b.value) ? b.value : 0)));

  return (
    <ul className="space-y-2.5" aria-label={ariaLabel}>
      {bars.map((bar) => {
        const safe = Number.isFinite(bar.value) && bar.value > 0 ? bar.value : 0;
        // largest === 0 means every value is zero. Without this guard the width
        // is 0/0 — and a NaN width renders as the FULL track, turning a chart
        // of nothing into a chart of everything.
        const width = largest > 0 ? (safe / largest) * 100 : 0;
        const row = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="truncate text-sm text-app-ink" title={bar.label}>
                {bar.label}
              </span>
              <span className="flex-shrink-0 font-numerals text-sm font-semibold text-app-ink">
                {bar.display}
              </span>
            </div>
            <div
              data-chart-bar
              className="h-2 w-full overflow-hidden rounded-full bg-app-surface-alt"
            >
              <div
                data-chart-bar-fill
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${width}%`, backgroundColor: toneColor(bar.tone ?? tone) }}
              />
            </div>
            {bar.hint && <p className="mt-1 text-xs text-app-ink-muted">{bar.hint}</p>}
          </>
        );

        return (
          <li key={bar.id} data-testid={`bar-${bar.id}`} data-bar-width={width}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(bar)}
                className="w-full rounded-lg px-1 py-1 text-start transition-colors hover:bg-app-surface-alt/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
              >
                {row}
              </button>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}
