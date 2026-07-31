import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BarChart from './BarChart';
import DonutChart from './DonutChart';
import LineChart from './LineChart';

/**
 * The charts as they actually render.
 *
 * `scale.test.ts` proves the arithmetic; this proves it reaches the DOM. Every
 * case below is one where the component still renders a chart-shaped thing and
 * the shape is wrong — no error, no warning, and figures printed beside it that
 * are perfectly correct.
 */

const money = (n: number) => n.toFixed(0);

describe('BarChart', () => {
  const bars = [
    { id: 'a', label: 'مورّد الشام', value: 100, display: '100' },
    { id: 'b', label: 'مورّد النيل', value: 50, display: '50' },
  ];

  it('measures every bar against the largest', () => {
    render(<BarChart bars={bars} ariaLabel="الموردون" />);
    expect(screen.getByTestId('bar-a')).toHaveAttribute('data-bar-width', '100');
    expect(screen.getByTestId('bar-b')).toHaveAttribute('data-bar-width', '50');
  });

  it('THE ONE THAT INVERTS: all zeros draw EMPTY bars, not full ones', () => {
    // width = value / largest = 0 / 0 = NaN, and a NaN width renders as the
    // full track. A quiet week would show every supplier maxed out.
    render(
      <BarChart
        bars={[
          { id: 'a', label: 'أ', value: 0, display: '0' },
          { id: 'b', label: 'ب', value: 0, display: '0' },
        ]}
        ariaLabel="فارغ"
      />,
    );
    expect(screen.getByTestId('bar-a')).toHaveAttribute('data-bar-width', '0');
    expect(screen.getByTestId('bar-b')).toHaveAttribute('data-bar-width', '0');
  });

  it('draws a negative as nothing but still PRINTS the figure', () => {
    // The bar cannot show it, so the number has to. Hiding the row would make
    // a wrong figure invisible instead of obvious.
    render(
      <BarChart
        bars={[{ id: 'a', label: 'خطأ', value: -20, display: '-20' }]}
        ariaLabel="سالب"
      />,
    );
    expect(screen.getByTestId('bar-a')).toHaveAttribute('data-bar-width', '0');
    expect(screen.getByText('-20')).toBeInTheDocument();
  });

  it('shows the label and the value for every row', () => {
    render(<BarChart bars={bars} ariaLabel="الموردون" />);
    expect(screen.getByText('مورّد الشام')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
  });
});

describe('DonutChart', () => {
  const slices = [
    { id: 'a', label: 'منتهي الصلاحية', value: 60, display: '60', tone: 1 as const },
    { id: 'b', label: 'تالف', value: 40, display: '40', tone: 2 as const },
  ];

  it('draws one arc per slice', () => {
    const { container } = render(
      <DonutChart slices={slices} centerLabel="الإجمالي" centerValue="100" ariaLabel="الهدر" />,
    );
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });

  it('THE ONE THAT DISAPPEARS: a single category still draws a ring', () => {
    // An arc of exactly 360° starts and ends at the same point, and SVG draws
    // nothing. A restaurant with one waste cause would see an empty circle and
    // a legend claiming it is 100%.
    const { container } = render(
      <DonutChart
        slices={[{ id: 'only', label: 'منتهي الصلاحية', value: 90, display: '90', tone: 1 }]}
        centerLabel="الإجمالي"
        centerValue="90"
        ariaLabel="الهدر"
      />,
    );
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute('d')).not.toBe('');
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('keeps its shape when everything is zero', () => {
    const { container } = render(
      <DonutChart
        slices={[{ id: 'a', label: 'لا شيء', value: 0, display: '0', tone: 1 }]}
        centerLabel="الإجمالي"
        centerValue="0"
        ariaLabel="فارغ"
      />,
    );
    // No slices — but the ring and the total are still there, so the card
    // reads as "the answer is zero" rather than as a failure.
    expect(container.querySelectorAll('path')).toHaveLength(0);
    expect(container.querySelector('circle')).toBeInTheDocument();
    // The total sits in the hole — the first <text> in the svg.
    expect(container.querySelector('svg text')).toHaveTextContent('0');
  });

  it('puts the total where the reader is looking', () => {
    render(
      <DonutChart slices={slices} centerLabel="إجمالي الهدر" centerValue="100" ariaLabel="الهدر" />,
    );
    expect(screen.getByText('إجمالي الهدر')).toBeInTheDocument();
  });

  it('shows each share as a percentage, since an arc cannot be read', () => {
    render(
      <DonutChart slices={slices} centerLabel="الإجمالي" centerValue="100" ariaLabel="الهدر" />,
    );
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });
});

describe('LineChart', () => {
  const series = [{ key: 'revenue', name: 'الإيراد', tone: 1 as const }];
  const points = [
    { label: '01', values: { revenue: 100 } },
    { label: '02', values: { revenue: 0 } },
    { label: '03', values: { revenue: 250 } },
  ];

  it('draws a path per series', () => {
    const { container } = render(
      <LineChart points={points} series={series} formatValue={money} ariaLabel="الإيراد" />,
    );
    const paths = [...container.querySelectorAll('path')];
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute('d')).toMatch(/^M /);
  });

  it('never emits NaN into a path', () => {
    // SVG drops an unparseable path silently — the chart just goes blank and
    // nothing anywhere says why.
    const { container } = render(
      <LineChart
        points={[{ label: '01', values: {} }, { label: '02', values: { revenue: 5 } }]}
        series={series}
        formatValue={money}
        ariaLabel="الإيراد"
      />,
    );
    for (const path of container.querySelectorAll('path')) {
      expect(path.getAttribute('d')).not.toMatch(/NaN/);
    }
  });

  it('draws a DOT when there is only one period', () => {
    // A path of one point renders nothing. "We opened yesterday" would look
    // like a broken chart.
    const { container } = render(
      <LineChart
        points={[{ label: '01', values: { revenue: 40 } }]}
        series={series}
        formatValue={money}
        ariaLabel="الإيراد"
      />,
    );
    expect(container.querySelector('circle')).toBeInTheDocument();
  });

  it('marks the zero line when a series goes negative', () => {
    const { container } = render(
      <LineChart
        points={[
          { label: '01', values: { profit: -50 } },
          { label: '02', values: { profit: 80 } },
        ]}
        series={[{ key: 'profit', name: 'الربح', tone: 2 }]}
        formatValue={money}
        ariaLabel="الربح"
      />,
    );
    // The gridlines plus one heavier line at zero — without it, a loss and a
    // small profit look like the same thing.
    const heavier = [...container.querySelectorAll('line')].filter(
      (l) => l.getAttribute('stroke-width') === '1.5',
    );
    expect(heavier).toHaveLength(1);
  });

  it('labels both ends of the timeline', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      label: String(i).padStart(2, '0'),
      values: { revenue: i },
    }));
    const { container } = render(
      <LineChart points={many} series={series} formatValue={money} ariaLabel="الإيراد" />,
    );
    // Thinned in the middle, but a timeline with no first or last label cannot
    // be read at all. Read from the axis specifically — "29" is also a gridline
    // value here, and matching that instead would pass with no labels at all.
    const axis = [...container.querySelectorAll('text')]
      .filter((t) => t.getAttribute('y') === String(220 - 8))
      .map((t) => t.textContent);

    expect(axis[0]).toBe('00');
    expect(axis[axis.length - 1]).toBe('29');
    expect(axis.length).toBeLessThan(many.length);
  });

  it('names itself for a reader who cannot see it', () => {
    render(
      <LineChart points={points} series={series} formatValue={money} ariaLabel="الإيراد اليومي" />,
    );
    expect(screen.getByRole('img', { name: 'الإيراد اليومي' })).toBeInTheDocument();
  });
});
