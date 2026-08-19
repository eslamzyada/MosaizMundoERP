import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import MetricWidget from './MetricWidget';

/**
 * A number on a dashboard is a question, and it used to be a dead end.
 *
 * "نواقص المخزون: 3" with no way to reach the three — every tile was a static
 * card. And no tile said whether its figure was better or worse than before,
 * which is most of what makes a figure mean anything.
 */
const base = { label: 'إجمالي المبيعات', accent: 'sunset' as const, icon: <svg /> };

const renderWidget = (props: Partial<React.ComponentProps<typeof MetricWidget>>) =>
  render(
    <MemoryRouter>
      <MetricWidget {...base} value="1,200.00" {...props} />
    </MemoryRouter>,
  );

describe('a metric you can open', () => {
  it('is a link when there is a page that explains it', () => {
    renderWidget({ to: '/reports' });
    expect(screen.getByRole('link')).toHaveAttribute('href', '/reports');
  });

  it('is NOT a link when the role may not open that page', () => {
    // The caller passes `to` only for pages this role can reach. A tile that
    // bounces off the route guard reads as a broken app rather than as a page
    // that is not theirs.
    renderWidget({ to: undefined });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('1,200.00')).toBeInTheDocument();
  });
});

describe('the change against the previous window', () => {
  it('shows a rise with a direction, not by colour alone', () => {
    // Colour cannot carry this on its own: it is invisible to a colourblind
    // manager, and on "stock shortages" a rise in green would be actively
    // misleading.
    renderWidget({ delta: 0.25 });
    expect(screen.getByText(/▲/)).toBeInTheDocument();
    expect(screen.getByText(/25/)).toBeInTheDocument();
  });

  it('shows a fall', () => {
    renderWidget({ delta: -0.4 });
    expect(screen.getByText(/▼/)).toBeInTheDocument();
  });

  it('says so plainly when nothing moved', () => {
    renderWidget({ delta: 0 });
    expect(screen.getByText('كما في الفترة السابقة')).toBeInTheDocument();
  });

  it('shows no comparison at all when there is no baseline', () => {
    // A first day. "▲ 100%" from a base of zero is a lie told with arithmetic.
    renderWidget({ delta: null });
    expect(screen.queryByText(/▲|▼/)).not.toBeInTheDocument();
  });

  it('shows no comparison while the figure is still loading', () => {
    renderWidget({ delta: 0.5, loading: true });
    expect(screen.queryByText(/▲/)).not.toBeInTheDocument();
  });
});
