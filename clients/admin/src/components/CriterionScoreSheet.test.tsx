import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CriterionScoreSheet from './CriterionScoreSheet';
import CriteriaManager from './CriteriaManager';
import { apiClient } from '../api/client';

/**
 * Scoring against the rubric, and editing the rubric itself.
 *
 * The things worth pinning here are the ones a screenshot of a working screen
 * cannot show: that the month is never sent by the client, that a criterion the
 * server refuses to delete produces the server's explanation rather than a
 * generic failure, and that a manager who cannot score still SEES the standard.
 */

const CRITERIA = [
  { id: 'c1', name: 'الالتزام بالمواعيد', description: 'الحضور في الموعد', weight: 1, is_active: true, sort_order: 1 },
  { id: 'c2', name: 'جودة الخدمة', description: null, weight: 2, is_active: true, sort_order: 2 },
  { id: 'c3', name: 'معيار موقوف', description: null, weight: 1, is_active: false, sort_order: 3 },
];

const SCORES = {
  month: '2026-08',
  is_open: true,
  employees: [
    {
      employee_id: 'emp-1',
      scores: [
        { criterion_id: 'c1', criterion_name: 'الالتزام بالمواعيد', criterion_is_active: true, weight: 1, score: 4, note: null },
      ],
      weighted_average: 4,
    },
  ],
};

function stub(overrides: { criteria?: unknown; scores?: unknown } = {}) {
  return vi.spyOn(apiClient, 'get').mockImplementation((url: string, config?: unknown) => {
    if (url === '/api/rating-criteria') {
      const params = (config as { params?: { include_retired?: string } } | undefined)?.params;
      const all = (overrides.criteria as typeof CRITERIA) ?? CRITERIA;
      return Promise.resolve({
        data: params?.include_retired === 'true' ? all : all.filter((c) => c.is_active),
      }) as never;
    }
    return Promise.resolve({ data: overrides.scores ?? SCORES }) as never;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the score sheet', () => {
  it('shows every ACTIVE criterion, and the score already given', async () => {
    stub();
    render(<CriterionScoreSheet employeeId="emp-1" employeeLabel="سارة" canScore />);

    expect(await screen.findByText('الالتزام بالمواعيد')).toBeInTheDocument();
    // Retired criteria are not on the sheet — they keep their history and
    // leave the form.
    expect(screen.queryByText('معيار موقوف')).not.toBeInTheDocument();

    const given = screen.getByRole('button', { name: 'الالتزام بالمواعيد: 4' });
    expect(given).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the SERVER\'s weighted average, not one it computed itself', async () => {
    // Two clients deriving this would eventually derive it differently, and a
    // review is not a place for two answers.
    stub();
    render(<CriterionScoreSheet employeeId="emp-1" employeeLabel="سارة" canScore />);

    // Read from the summary line, not by text — "4" is also the label of a
    // score button, and matching that would pass with no average shown at all.
    const summary = await screen.findByText(/المتوسط المرجّح/);
    expect(summary).toHaveTextContent('4');
    expect(summary).toHaveTextContent('من ٥');
  });

  it('NEVER sends the month — that is the server\'s to decide', async () => {
    // Only the current month is writable, and a client naming one is a client
    // inviting a request the database is going to refuse.
    stub();
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();

    render(<CriterionScoreSheet employeeId="emp-1" employeeLabel="سارة" canScore />);
    await screen.findByText('جودة الخدمة');
    await user.click(screen.getByRole('button', { name: 'جودة الخدمة: 5' }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual({
      employee_id: 'emp-1',
      criterion_id: 'c2',
      score: 5,
      note: undefined,
    });
    expect(Object.keys(body)).not.toContain('period_month');
  });

  it('a reader who cannot score still SEES the standard', async () => {
    // The whole reason the rubric is readable by everyone.
    stub();
    render(<CriterionScoreSheet employeeId="emp-1" employeeLabel="سارة" canScore={false} />);

    expect(await screen.findByText('الالتزام بالمواعيد')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'جودة الخدمة: 5' })).toBeDisabled();
    expect(screen.getByText(/صلاحيات المديرين/)).toBeInTheDocument();
  });

  it('says what to do when there are no criteria yet', async () => {
    stub({ criteria: [] });
    render(<CriterionScoreSheet employeeId="emp-1" employeeLabel="سارة" canScore />);

    expect(await screen.findByText(/لا توجد معايير بعد/)).toBeInTheDocument();
  });
});

describe('managing the rubric', () => {
  it('separates the active list from the retired one', async () => {
    stub();
    render(<CriteriaManager canManage />);

    expect(await screen.findByTestId('criterion-c1')).toBeInTheDocument();
    // The retired one is present but folded away, so it can be brought back
    // without cluttering the list that is in use.
    expect(screen.getByText(/معايير موقوفة/)).toBeInTheDocument();
  });

  it('passes the SERVER\'s refusal through when a criterion is in use', async () => {
    // "Retire it instead" is the useful sentence, and only the server knows to
    // say it — the client cannot tell a used criterion from an unused one.
    stub();
    vi.spyOn(apiClient, 'delete').mockRejectedValue({
      response: {
        status: 409,
        data: { error: 'This criterion has already been used in a review. Retire it instead.' },
        },
    });
    const user = userEvent.setup();

    render(<CriteriaManager canManage />);
    const row = await screen.findByTestId('criterion-c1');
    await user.click(within(row).getByRole('button', { name: 'حذف' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Retire it instead/);
  });

  it('offers nothing to change to somebody who may not', async () => {
    stub();
    render(<CriteriaManager canManage={false} />);

    await screen.findByTestId('criterion-c1');
    expect(screen.queryByRole('button', { name: 'حذف' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إضافة معيار' })).not.toBeInTheDocument();
    // …but the list itself is still there.
    expect(screen.getByText('جودة الخدمة')).toBeInTheDocument();
  });
});
