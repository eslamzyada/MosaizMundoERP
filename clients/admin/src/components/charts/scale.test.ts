import { describe, expect, it } from 'vitest';
import {
  arcPath,
  areaPath,
  domainOf,
  linePath,
  makeScale,
  pickLabelIndices,
  sliceFractions,
  ticksFor,
} from './scale';

/**
 * The arithmetic behind the charts.
 *
 * Every case here is a way a chart draws something rather than failing. A blank
 * SVG, a bar at full height for a value of zero, an upside-down profit line, a
 * donut that disappears when there is only one supplier — none of them throw,
 * none of them log, and all of them look like a working chart until you check
 * the numbers printed next to them.
 */

describe('domainOf', () => {
  it('ALWAYS includes zero, so a bar chart cannot exaggerate', () => {
    // 90, 95, 100 scaled to its own minimum draws the first bar as a sliver
    // and the last as full height: a 10% spread shown as a 10× one, with
    // correct figures printed beside it.
    expect(domainOf([90, 95, 100])).toEqual({ min: 0, max: 100 });
  });

  it('survives an empty series instead of producing Infinity', () => {
    // Math.max() of nothing is -Infinity, and every coordinate downstream
    // becomes NaN. SVG drops an unparseable path in silence.
    expect(domainOf([])).toEqual({ min: 0, max: 1 });
  });

  it('never returns a zero-width range', () => {
    // All zeros divides by zero one step later, and depending on which way the
    // NaN falls every bar renders FULL height — a chart of nothing that reads
    // as a chart of everything.
    const flat = domainOf([0, 0, 0]);
    expect(flat.max).toBeGreaterThan(flat.min);

    const same = domainOf([7, 7, 7]);
    expect(same.max).toBeGreaterThan(same.min);
  });

  it('keeps a loss below the line', () => {
    expect(domainOf([-30, 5, 20])).toEqual({ min: -30, max: 20 });
  });

  it('ignores values that are not numbers', () => {
    expect(domainOf([10, NaN, 20, Infinity])).toEqual({ min: 0, max: 20 });
  });
});

describe('makeScale', () => {
  const domain = { min: 0, max: 100 };

  it('puts the largest value at the TOP', () => {
    // SVG y grows downward. Getting this backwards draws a chart that is
    // upside down and entirely plausible: profit falls as it rises.
    const y = makeScale(domain, 10, 110);
    expect(y(100)).toBe(10);
    expect(y(0)).toBe(110);
    expect(y(50)).toBe(60);
  });

  it('places zero between the ends when the data crosses it', () => {
    const y = makeScale({ min: -50, max: 50 }, 0, 100);
    expect(y(0)).toBe(50);
    expect(y(-50)).toBe(100);
    expect(y(50)).toBe(0);
  });

  it('does not divide by zero on a flat domain', () => {
    const y = makeScale({ min: 5, max: 5 }, 0, 100);
    expect(Number.isFinite(y(5))).toBe(true);
  });

  it('keeps a non-numeric value on the baseline rather than off-screen', () => {
    const y = makeScale(domain, 0, 100);
    expect(y(NaN)).toBe(100);
  });
});

describe('ticksFor', () => {
  it('spans the domain end to end', () => {
    const ticks = ticksFor({ min: 0, max: 100 }, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(100);
  });

  it('includes zero when the data crosses it', () => {
    // The one gridline that means something on a chart with losses on it.
    const ticks = ticksFor({ min: -30, max: 70 }, 3);
    expect(ticks.some((t) => Math.abs(t) < 1e-9)).toBe(true);
  });

  it('stays sorted after zero is inserted', () => {
    const ticks = ticksFor({ min: -30, max: 70 }, 3);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
  });
});

describe('linePath', () => {
  const x = (i: number) => i * 10;
  const y = (v: number) => 100 - v;

  it('draws a series', () => {
    expect(linePath([0, 50, 100], x, y)).toBe('M 0 100 L 10 50 L 20 0');
  });

  it('returns NULL for an empty series rather than an empty path', () => {
    // An empty `d` renders as nothing, which is indistinguishable from a chart
    // that failed to load. Null forces the caller to say which it is.
    expect(linePath([], x, y)).toBeNull();
  });

  it('draws a single point without producing NaN', () => {
    const path = linePath([42], x, y);
    expect(path).toBe('M 0 58');
    expect(path).not.toMatch(/NaN/);
  });
});

describe('areaPath', () => {
  it('closes to the ZERO line, not to the bottom of the box', () => {
    // With a loss in the series the bottom of the box is below zero, and
    // filling to it shades the loss as though it were part of the gain.
    const path = areaPath([10, -10], (i) => i * 10, (v) => 50 - v, 50);
    expect(path).toContain('L 10 50 L 0 50 Z');
  });

  it('is null when there is nothing to close', () => {
    expect(areaPath([], (i) => i, (v) => v, 0)).toBeNull();
  });
});

describe('sliceFractions', () => {
  it('normalises to one', () => {
    expect(sliceFractions([1, 1, 2])).toEqual([0.25, 0.25, 0.5]);
  });

  it('is empty when nothing sums to anything', () => {
    // The caller draws an empty ring and says why, rather than dividing by zero.
    expect(sliceFractions([0, 0])).toEqual([]);
    expect(sliceFractions([])).toEqual([]);
  });

  it('clamps a negative to zero rather than dropping the row', () => {
    // Dropping it would leave a legend entry with no slice, and the reader
    // hunting for a colour that is not on the chart.
    expect(sliceFractions([-5, 10])).toEqual([0, 1]);
  });
});

describe('arcPath', () => {
  it('draws a partial slice', () => {
    const d = arcPath(50, 50, 40, 25, 0, 0.25);
    expect(d).toMatch(/^M /);
    expect(d).not.toMatch(/NaN/);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('THE ONE THAT DISAPPEARS: a single category fills the whole ring', () => {
    // An SVG arc whose start and end points are identical draws NOTHING. A
    // restaurant buying from one supplier would get a donut showing an empty
    // circle, with a legend saying that supplier is 100%.
    const d = arcPath(50, 50, 40, 25, 0, 1);
    expect(d).not.toBe('');
    // Two outer half-arcs and two inner ones — the shape that actually renders.
    expect((d.match(/A /g) ?? []).length).toBe(4);
  });

  it('flags a slice over half the circle as a large arc', () => {
    // Without the large-arc flag, a 70% slice draws as the 30% one.
    expect(arcPath(50, 50, 40, 25, 0, 0.7)).toMatch(/A 40 40 0 1 1/);
    expect(arcPath(50, 50, 40, 25, 0, 0.3)).toMatch(/A 40 40 0 0 1/);
  });

  it('draws nothing for an empty slice', () => {
    expect(arcPath(50, 50, 40, 25, 0.5, 0.5)).toBe('');
  });

  it('starts at the top of the circle, where a reader expects it', () => {
    // Twelve o'clock. SVG angles start at three o'clock, so a missing −90°
    // rotation silently turns every donut a quarter turn.
    expect(arcPath(50, 50, 40, 25, 0, 0.25)).toMatch(/^M 50 10/);
  });
});

describe('pickLabelIndices', () => {
  it('prints them all when they fit', () => {
    expect(pickLabelIndices(5, 8)).toEqual([0, 1, 2, 3, 4]);
  });

  it('thins them out when they do not', () => {
    const picked = pickLabelIndices(30, 6);
    expect(picked.length).toBeLessThanOrEqual(7);
  });

  it('ALWAYS keeps both ends', () => {
    // A timeline whose first and last labels are missing cannot be read at
    // all, however neatly the middle is spaced.
    const picked = pickLabelIndices(30, 6);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(29);
  });

  it('handles a single label, and none', () => {
    expect(pickLabelIndices(1, 6)).toEqual([0]);
    expect(pickLabelIndices(0, 6)).toEqual([]);
  });
});
