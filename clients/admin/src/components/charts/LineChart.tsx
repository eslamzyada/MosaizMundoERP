import { toneColor } from './ChartCard';
import type { Tone } from './ChartCard';
import { areaPath, domainOf, linePath, makeScale, pickLabelIndices, ticksFor } from './scale';

/**
 * One or more measures over time.
 *
 * Drawn by hand rather than with a charting library, for one reason that
 * matters here more than bundle size: this app's theme is a set of CSS custom
 * properties, and a library wants colours as JavaScript strings. Feeding it
 * hex values means the chart keeps its light-theme palette when everything
 * around it goes dark — the exact failure the printers page still has. An SVG
 * whose fills are `rgb(var(--chart-1))` follows the theme without being told.
 *
 * The time axis runs LEFT TO RIGHT even though the page is RTL. Same decision
 * as `.font-numerals`: a period, like a number, is read in its own direction,
 * and every other tool the reader compares this against does the same.
 */

export interface LineSeries {
  key: string;
  name: string;
  tone: Tone;
  /** Shade beneath the line. Only legible for one series at a time. */
  fill?: boolean;
}

export interface LinePoint {
  label: string;
  values: Record<string, number>;
}

const VIEW_W = 720;
const PAD = { top: 12, right: 12, bottom: 26, left: 56 };

export default function LineChart({
  points,
  series,
  formatValue,
  height = 220,
  ariaLabel,
  maxLabels = 7,
}: {
  points: LinePoint[];
  series: LineSeries[];
  formatValue: (value: number) => string;
  height?: number;
  ariaLabel: string;
  maxLabels?: number;
}) {
  const all = points.flatMap((p) => series.map((s) => p.values[s.key] ?? 0));
  const domain = domainOf(all);
  const y = makeScale(domain, PAD.top, height - PAD.bottom);

  const plotWidth = VIEW_W - PAD.left - PAD.right;
  // A single point has nowhere to go horizontally; put it in the middle rather
  // than dividing by zero and pushing it off the left edge.
  const x = (index: number) =>
    points.length <= 1
      ? PAD.left + plotWidth / 2
      : PAD.left + (index / (points.length - 1)) * plotWidth;

  const ticks = ticksFor(domain, 4);
  const labelled = pickLabelIndices(points.length, maxLabels);
  const zeroY = y(0);
  const crossesZero = domain.min < 0 && domain.max > 0;

  return (
    <div dir="ltr">
      <svg
        data-chart="line"
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
      >
        {/* Gridlines and their values. Drawn first so the data sits on top. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="rgb(var(--chart-grid))"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={11}
              fill="rgb(var(--app-ink-muted))"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}

        {/* Zero, drawn heavier — on a chart with losses it is the only line
            that separates making money from losing it. */}
        {crossesZero && (
          <line
            x1={PAD.left}
            x2={VIEW_W - PAD.right}
            y1={zeroY}
            y2={zeroY}
            stroke="rgb(var(--app-ink-muted))"
            strokeWidth={1.5}
          />
        )}

        {series.map((s) => {
          const values = points.map((p) => p.values[s.key] ?? 0);
          const d = linePath(values, x, y);
          if (d === null) return null;
          const area = s.fill ? areaPath(values, x, y, zeroY) : null;

          return (
            <g key={s.key}>
              {area && <path d={area} fill={toneColor(s.tone)} opacity={0.12} stroke="none" />}
              <path
                d={d}
                fill="none"
                stroke={toneColor(s.tone)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {/* A single period is a dot: a path of one point draws nothing,
                  and an empty chart for "we opened yesterday" reads as broken. */}
              {points.length === 1 && (
                <circle cx={x(0)} cy={y(values[0])} r={3.5} fill={toneColor(s.tone)} />
              )}
            </g>
          );
        })}

        {labelled.map((index) => (
          <text
            key={index}
            x={x(index)}
            y={height - 8}
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            fontSize={11}
            fill="rgb(var(--app-ink-muted))"
          >
            {points[index]?.label}
          </text>
        ))}
      </svg>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1" dir="rtl">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-xs text-app-ink-muted">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-sm"
              style={{ backgroundColor: toneColor(s.tone) }}
            />
            {s.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
