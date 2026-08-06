import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Schedule from './Schedule';
import { apiClient } from '../api/client';
import * as session from '../session/SessionProvider';

/**
 * Pay and labour cost on the rota screen (0042).
 *
 * The assertions worth having are the two that a screenshot would not catch:
 * a cost of null must never render as 0.00, and a total must never be shown
 * without saying what it left out.
 */

const hoursReport = (over: Record<string, unknown> = {}) => ({
  from: new Date().toISOString(),
  to: new Date().toISOString(),
  by_employee: [
    { user_id: 'u-1', minutes: 600, hours: 10, entries: 1, cost: 300, uncosted_entries: 0 },
    { user_id: 'u-2', minutes: 120, hours: 2, entries: 1, cost: null, uncosted_entries: 1 },
  ],
  total_cost: 300,
  uncosted_entries: 1,
  ...over,
});

function stub(role = 'owner') {
  vi.spyOn(session, 'useSession').mockReturnValue({
    me: { user_id: 'u-1', organization_id: 'o1', role, modules: ['labour'] },
    loading: false,
    error: false,
    reload: vi.fn(),
    can: () => role !== 'waiter',
  } as unknown as ReturnType<typeof session.useSession>);

  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url.includes('/hours')) return Promise.resolve({ data: hoursReport() } as never);
    if (url.includes('/wages')) {
      return Promise.resolve({
        data: [
          { id: 'w1', user_id: 'u-1', hourly_rate: 30, effective_from: '2026-06-01', note: null, set_by: 'u-9' },
        ],
      } as never);
    }
    if (url.includes('/members')) {
      return Promise.resolve({
        data: [
          { user_id: 'u-1', email: 'a@dev.local', role: 'waiter' },
          { user_id: 'u-2', email: 'b@dev.local', role: 'kitchen' },
        ],
      } as never);
    }
    return Promise.resolve({ data: [] } as never);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('labour cost on the rota', () => {
  it('shows the cost it knows', async () => {
    stub();
    render(<Schedule />);

    const row = await screen.findByTestId('hours-u-1');
    expect(within(row).getByText(/300\.00/)).toBeInTheDocument();
  });

  it('says UNKNOWN rather than printing zero', async () => {
    // The one that matters. 0.00 would be read as "this person costs nothing",
    // and somebody would budget against it.
    stub();
    render(<Schedule />);

    const row = await screen.findByTestId('hours-u-2');
    expect(within(row).getByText('التكلفة غير معروفة')).toBeInTheDocument();
    expect(within(row).queryByText(/0\.00/)).not.toBeInTheDocument();
  });

  it('never shows a total without saying what it left out', async () => {
    stub();
    render(<Schedule />);

    const total = await screen.findByTestId('labour-cost-total');
    expect(total).toHaveTextContent('300.00');
    expect(total).toHaveTextContent(/تسجيل بلا أجر معروف/);
  });

  it('shows no total at all when nothing could be costed', async () => {
    stub();
    vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
      if (url.includes('/hours')) {
        return Promise.resolve({
          data: hoursReport({
            by_employee: [
              { user_id: 'u-2', minutes: 120, hours: 2, entries: 1, cost: null, uncosted_entries: 1 },
            ],
            total_cost: null,
          }),
        } as never);
      }
      return Promise.resolve({ data: [] } as never);
    });
    render(<Schedule />);

    const total = await screen.findByTestId('labour-cost-total');
    expect(total).not.toHaveTextContent(/ج\.م/);
    expect(total).toHaveTextContent(/تسجيل بلا أجر معروف/);
  });
});

describe('setting a rate', () => {
  it('sends a date STRING, not a Date', async () => {
    // @db.Date takes the UTC portion; a Date at local midnight east of UTC
    // would date the raise to the previous day.
    stub();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} } as never);
    const user = userEvent.setup();
    render(<Schedule />);

    const panel = await screen.findByTestId('wage-panel');
    // The members list arrives on its own request, so the panel can exist
    // before its options do. Waiting for the panel alone made this pass or
    // fail depending on timing, which is worse than failing.
    await within(panel).findByRole('option', { name: 'b@dev.local' });
    await user.selectOptions(within(panel).getByLabelText('الموظف'), 'u-2');
    await user.type(within(panel).getByLabelText('الأجر بالساعة'), '45');
    await user.click(within(panel).getByTestId('save-wage'));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1] as { effective_from: string };
    expect(typeof body.effective_from).toBe('string');
    expect(body.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses to send without a person chosen', async () => {
    stub();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} } as never);
    const user = userEvent.setup();
    render(<Schedule />);

    const panel = await screen.findByTestId('wage-panel');
    await user.type(within(panel).getByLabelText('الأجر بالساعة'), '45');
    await user.click(within(panel).getByTestId('save-wage'));

    expect(await within(panel).findByText('اختر الموظف.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});
