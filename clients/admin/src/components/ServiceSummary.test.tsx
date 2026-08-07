import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServiceSummary from './ServiceSummary';
import { apiClient } from '../api/client';

/**
 * The service summary.
 *
 * Every assertion here is about keeping three answers apart, because each
 * collapse produces a plausible number somebody would act on:
 *
 *   absent  — the restaurant does not run that capability
 *   unknown — it does, and this reader may not see the figure
 *   0       — it does, and the answer is genuinely none
 */

const report = (over: Record<string, unknown> = {}) => ({
  revenue: 1000,
  orders: 10,
  labour: { hours: 10, cost: 300, uncosted_entries: 0, share_of_revenue: 30 },
  covers: { booked: 4, seated: 3, no_show: 1, cancelled: 0, turned_into_money: 3, no_show_rate: 25 },
  online: { received: 5, accepted: 4, rejected: 1, pending: 0, acceptance_rate: 80 },
  ...over,
});

const show = (body: unknown) => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: body } as never);
  return render(<ServiceSummary from={new Date(Date.now() - 86400_000)} to={new Date()} />);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the headline', () => {
  it('shows labour as a share of revenue', async () => {
    show(report());
    expect(await screen.findByTestId('labour-share')).toHaveTextContent('30%');
  });

  it('marks a share above a third, because that is when it starts hurting', async () => {
    show(report({ labour: { hours: 20, cost: 400, uncosted_entries: 0, share_of_revenue: 40 } }));
    const el = await screen.findByTestId('labour-share');
    expect(el.querySelector('.text-sunset-600')).not.toBeNull();
  });

  it('does not mark a healthy share', async () => {
    show(report());
    const el = await screen.findByTestId('labour-share');
    expect(el.querySelector('.text-sunset-600')).toBeNull();
  });
});

describe('absent, unknown and zero stay apart', () => {
  it('a capability the restaurant does not run is ABSENT', async () => {
    show(report({ labour: null, covers: null, online: null }));

    await screen.findByTestId('service-summary');
    // Not "0 covers", which would read as a catastrophic night.
    expect(screen.queryByTestId('covers')).not.toBeInTheDocument();
    expect(screen.queryByTestId('labour-share')).not.toBeInTheDocument();
    expect(screen.queryByTestId('online')).not.toBeInTheDocument();
  });

  it('a figure this reader may not see says UNKNOWN, not 0%', async () => {
    show(report({ labour: { hours: 10, cost: null, uncosted_entries: 2, share_of_revenue: null } }));

    const el = await screen.findByTestId('labour-share');
    expect(el).toHaveTextContent('غير معروفة');
    expect(el).not.toHaveTextContent('0%');
    // The hours are still there — they are not the confidential part.
    expect(await screen.findByTestId('labour-hours')).toHaveTextContent('10');
  });

  it('names how much was left out of a partial cost', async () => {
    show(report({ labour: { hours: 10, cost: 100, uncosted_entries: 3, share_of_revenue: 10 } }));
    expect(await screen.findByTestId('labour-share')).toHaveTextContent(/3 تسجيل بلا أجر معروف/);
  });
});

describe('what needs somebody now', () => {
  it('marks online orders still waiting for an answer', async () => {
    show(report({ online: { received: 5, accepted: 2, rejected: 1, pending: 2, acceptance_rate: 67 } }));

    const el = await screen.findByTestId('online');
    expect(el).toHaveTextContent(/2 بانتظار الردّ/);
    expect(el.querySelector('.text-sunset-600')).not.toBeNull();
  });

  it('does not shout when nothing is waiting', async () => {
    show(report());
    const el = await screen.findByTestId('online');
    expect(el.querySelector('.text-sunset-600')).toBeNull();
  });
});

describe('when the answer is not usable', () => {
  it('a malformed payload costs ONE card, not the page', async () => {
    // The stub other suites use returns {} for unknown URLs. Reading
    // revenue off that and formatting it threw inside render and blanked the
    // whole dashboard — one summary is not worth that.
    show({});
    expect(await screen.findByText('تعذّر تحميل ملخّص الخدمة.')).toBeInTheDocument();
  });

  it('a failed request says so quietly', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network'));
    render(<ServiceSummary from={new Date(Date.now() - 86400_000)} to={new Date()} />);

    await waitFor(() =>
      expect(screen.getByText('تعذّر تحميل ملخّص الخدمة.')).toBeInTheDocument(),
    );
  });
});
