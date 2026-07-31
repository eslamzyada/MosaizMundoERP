/**
 * The arithmetic behind the charts, with no React and no SVG.
 *
 * It lives on its own because this is where a chart lies. A component that
 * renders is a component that looks finished; the ways these go wrong all
 * produce a picture rather than an error:
 *
 *   - an empty series makes max = -Infinity, and every coordinate becomes NaN.
 *     SVG silently drops a path it cannot parse, so the chart is simply blank
 *     and nothing in the console says why.
 *   - a series of all zeros divides by a zero range. Depending on which way the
 *     NaN falls, every bar renders full height — a chart of nothing that reads
 *     as a chart of everything.
 *   - a bar chart whose axis starts at the smallest value instead of at zero
 *     draws 90 as half the height of 100. The shape is a lie and the numbers
 *     printed next to it are correct, which is the hardest kind to notice.
 *   - an arc of exactly 360° starts and ends at the same point, and the SVG A
 *     command draws NOTHING. A single-category donut disappears entirely.
 */

export interface Domain {
  min: number;
  max: number;
}

/**
 * The value range a chart must cover.
 *
 * Always includes zero. A chart of 90, 95 and 100 scaled to its own minimum
 * shows the first bar as a sliver and the last as full height — a 10% spread
 * drawn as a 10× one. Including zero is what makes the picture agree with the
 * numbers beside it.
 *
 * Never returns min === max: a flat series still has to be drawable, and a
 * zero-width range is a division by zero one step later.
 */
export function domainOf(values: number[]): Domain {
  // Non-numbers are dropped rather than passed through: one NaN in a series
  // makes Math.min return NaN, and every coordinate after it is NaN too.
  const finite = values.filter((v) => Number.isFinite(v));

  // Seeded with 0 on both sides, which also makes an EMPTY series safe —
  // Math.min(0) is 0, not the Infinity that Math.min() of nothing returns.
  const min = Math.min(0, ...finite);
  const max = Math.max(0, ...finite);

  // Everything was zero, or there was nothing at all. Give it a nominal range
  // so the baseline draws and nothing divides by nothing.
  if (min === max) return { min, max: min + 1 };
  return { min, max };
}

/**
 * A function mapping a value onto a pixel coordinate between `top` and `bottom`.
 *
 * `top` is the SMALLER number — SVG y grows downward — so the returned function
 * is decreasing. Getting this backwards produces a chart that is upside down
 * but perfectly plausible: profit falls as it rises.
 */
export function makeScale(domain: Domain, top: number, bottom: number): (value: number) => number {
  const span = domain.max - domain.min;
  const height = bottom - top;
  if (span <= 0) return () => bottom;
  return (value: number) => {
    if (!Number.isFinite(value)) return bottom;
    const ratio = (value - domain.min) / span;
    return bottom - ratio * height;
  };
}

/**
 * Evenly spaced tick values across the domain, always including its ends and,
 * when the data crosses zero, zero itself — the one gridline that means
 * something on a chart with losses on it.
 */
export function ticksFor(domain: Domain, count = 4): number[] {
  const steps = Math.max(1, Math.floor(count));
  const out: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    out.push(domain.min + ((domain.max - domain.min) * i) / steps);
  }
  if (domain.min < 0 && domain.max > 0 && !out.some((t) => Math.abs(t) < 1e-9)) {
    out.push(0);
    out.sort((a, b) => a - b);
  }
  return out;
}

/**
 * An SVG path through a series, or null when there is nothing to draw.
 *
 * Null rather than an empty string so a caller has to decide what an empty
 * chart looks like. An empty `d` renders as nothing at all, which is
 * indistinguishable from a chart that failed to load.
 */
export function linePath(
  values: number[],
  x: (index: number) => number,
  y: (value: number) => number,
): string | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;

  return values
    .map((value, index) => `${index === 0 ? 'M' : 'L'} ${round(x(index))} ${round(y(value))}`)
    .join(' ');
}

/**
 * The same series as a closed shape down to the zero line, for a shaded area.
 *
 * Closed to ZERO rather than to the bottom of the box: with a negative value in
 * the series the bottom is below zero, and filling to it shades the loss as
 * though it were part of the gain.
 */
export function areaPath(
  values: number[],
  x: (index: number) => number,
  y: (value: number) => number,
  zeroY: number,
): string | null {
  const line = linePath(values, x, y);
  if (line === null || values.length === 0) return null;
  return `${line} L ${round(x(values.length - 1))} ${round(zeroY)} L ${round(x(0))} ${round(zeroY)} Z`;
}

/**
 * Fractions of a whole, for a donut or a stacked bar.
 *
 * Negatives are clamped to zero rather than dropped: "this category is negative"
 * is not something a share-of-total can express, but silently removing the row
 * would leave a legend with an entry that has no slice. Returns an empty array
 * when nothing sums to anything — the caller shows an empty ring and says so.
 */
export function sliceFractions(values: number[]): number[] {
  const safe = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = safe.reduce((s, v) => s + v, 0);
  if (total <= 0) return [];
  return safe.map((v) => v / total);
}

/**
 * A donut segment between two fractions of the circle.
 *
 * The full-circle case is special-cased. An SVG arc whose start and end points
 * are identical draws nothing at all, so a donut with one category — the common
 * case for a restaurant that buys from a single supplier — vanishes. Two
 * half-arcs are used instead.
 */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startFraction: number,
  endFraction: number,
): string {
  const sweep = Math.min(Math.max(endFraction - startFraction, 0), 1);
  if (sweep <= 0) return '';

  if (sweep >= 1) {
    // Two 180° arcs, outer then inner, giving a complete ring with a hole.
    return [
      `M ${round(cx - outer)} ${round(cy)}`,
      `A ${round(outer)} ${round(outer)} 0 1 1 ${round(cx + outer)} ${round(cy)}`,
      `A ${round(outer)} ${round(outer)} 0 1 1 ${round(cx - outer)} ${round(cy)}`,
      `M ${round(cx - inner)} ${round(cy)}`,
      `A ${round(inner)} ${round(inner)} 0 1 0 ${round(cx + inner)} ${round(cy)}`,
      `A ${round(inner)} ${round(inner)} 0 1 0 ${round(cx - inner)} ${round(cy)}`,
      'Z',
    ].join(' ');
  }

  const a0 = startFraction * Math.PI * 2 - Math.PI / 2;
  const a1 = endFraction * Math.PI * 2 - Math.PI / 2;
  const large = sweep > 0.5 ? 1 : 0;

  const p = (radius: number, angle: number) => ({
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  });

  const o0 = p(outer, a0);
  const o1 = p(outer, a1);
  const i1 = p(inner, a1);
  const i0 = p(inner, a0);

  return [
    `M ${round(o0.x)} ${round(o0.y)}`,
    `A ${round(outer)} ${round(outer)} 0 ${large} 1 ${round(o1.x)} ${round(o1.y)}`,
    `L ${round(i1.x)} ${round(i1.y)}`,
    `A ${round(inner)} ${round(inner)} 0 ${large} 0 ${round(i0.x)} ${round(i0.y)}`,
    'Z',
  ].join(' ');
}

/**
 * Which of `count` labels to actually print, given room for `max` of them.
 *
 * Always keeps the first and the last: a timeline whose ends are unlabelled
 * cannot be read at all, however neatly the middle is spaced.
 */
export function pickLabelIndices(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max || max < 2) return Array.from({ length: count }, (_, i) => i);

  // The step spans the GAPS between labels, not the labels — (count - 1) over
  // (max - 1). With count/max the last index lands short of the end and the
  // timeline loses the label that says where it stops.
  const step = (count - 1) / (max - 1);
  const picked = new Set<number>();
  for (let i = 0; i < max; i += 1) picked.add(Math.round(i * step));
  return [...picked].sort((a, b) => a - b);
}

/** Two decimal places is below a pixel at any size we render, and keeps the DOM small. */
function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
