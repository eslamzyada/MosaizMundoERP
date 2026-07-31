import { toneColor } from './ChartCard';
import type { Tone } from './ChartCard';
import { arcPath, sliceFractions } from './scale';

/**
 * How a total splits — waste by cause, orders by status, capital by ingredient.
 *
 * A donut rather than a pie so the total can live in the hole. The share of a
 * slice is the hard thing to read off a circle; the number that was actually
 * asked for is usually the total, and putting it in the middle means nobody has
 * to estimate anything.
 *
 * The legend carries the figures, so the chart is a shape and the legend is the
 * data. Reading a value off an arc is guesswork at the best of times and
 * impossible below about 5%.
 */

export interface Slice {
  id: string;
  label: string;
  value: number;
  display: string;
  tone: Tone;
}

const SIZE = 180;
const OUTER = 78;
const INNER = 52;

export default function DonutChart({
  slices,
  centerLabel,
  centerValue,
  ariaLabel,
}: {
  slices: Slice[];
  centerLabel: string;
  centerValue: string;
  ariaLabel: string;
}) {
  const fractions = sliceFractions(slices.map((s) => s.value));
  // Empty means nothing summed to anything. An empty ring is drawn rather than
  // nothing at all, so the card keeps its shape and the reader can see that the
  // question was asked and the answer was zero.
  const hasData = fractions.length > 0;

  let cursor = 0;

  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <svg
        data-chart="donut"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={ariaLabel}
        className="flex-shrink-0"
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={(OUTER + INNER) / 2}
          fill="none"
          stroke="rgb(var(--chart-grid))"
          strokeWidth={OUTER - INNER}
        />

        {hasData &&
          slices.map((slice, index) => {
            const start = cursor;
            cursor += fractions[index];
            const d = arcPath(SIZE / 2, SIZE / 2, OUTER, INNER, start, cursor);
            if (!d) return null;
            return <path key={slice.id} d={d} fill={toneColor(slice.tone)} />;
          })}

        <text
          x={SIZE / 2}
          y={SIZE / 2 - 2}
          textAnchor="middle"
          fontSize={17}
          fontWeight={700}
          fill="rgb(var(--app-ink))"
          style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }}
        >
          {centerValue}
        </text>
        <text
          x={SIZE / 2}
          y={SIZE / 2 + 16}
          textAnchor="middle"
          fontSize={11}
          fill="rgb(var(--app-ink-muted))"
        >
          {centerLabel}
        </text>
      </svg>

      <ul className="min-w-[11rem] flex-1 space-y-1.5">
        {slices.map((slice, index) => (
          <li key={slice.id} className="flex items-center gap-2 text-sm">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
              style={{ backgroundColor: toneColor(slice.tone) }}
            />
            <span className="flex-1 truncate text-app-ink" title={slice.label}>
              {slice.label}
            </span>
            <span className="font-numerals text-app-ink-muted">{slice.display}</span>
            {hasData && (
              <span className="w-12 text-end font-numerals text-xs text-app-ink-muted">
                {(fractions[index] * 100).toFixed(0)}%
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
