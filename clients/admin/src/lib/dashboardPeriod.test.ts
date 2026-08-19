import { describe, expect, it } from 'vitest';
import { PERIODS, changeFrom } from './dashboardPeriod';

describe('the change against the previous window', () => {
  it('is a fraction, up and down', () => {
    expect(changeFrom(100, 120)).toBeCloseTo(0.2);
    expect(changeFrom(100, 80)).toBeCloseTo(-0.2);
  });

  it('says nothing rather than infinity when there is no baseline', () => {
    // A first day, or a restaurant that was closed. "▲ ∞%" is a lie told with
    // arithmetic, and "▲ 100%" from a base of zero is not better.
    expect(changeFrom(0, 500)).toBeNull();
  });

  it('says nothing when a figure is missing', () => {
    expect(changeFrom(Number.NaN, 5)).toBeNull();
    expect(changeFrom(5, Number.NaN)).toBeNull();
  });

  it('reports a fall to zero honestly', () => {
    // Took nothing today after taking money yesterday: -100%, not "no data".
    expect(changeFrom(400, 0)).toBeCloseTo(-1);
  });

  it('every period states its own window', () => {
    // The caption is the whole point: a number whose period is implied is how
    // "today" came to mean "the last hundred orders".
    for (const p of PERIODS) {
      expect(p.caption.length).toBeGreaterThan(4);
      expect(p.days).toBeGreaterThan(0);
    }
  });
});
