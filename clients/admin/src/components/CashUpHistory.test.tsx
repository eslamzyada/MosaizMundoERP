import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CashUpHistory from './CashUpHistory';
import { apiClient } from '../api/client';

/**
 * Cash-ups, and the pattern in them.
 *
 * This screen puts names next to missing money, which makes overstating worse
 * than saying nothing. Nearly every assertion here is about restraint:
 *
 *   a count is never shown without its denominator;
 *   net is never shown without the money that actually went missing;
 *   nobody is ranked, scored, or coloured by how bad they look.
 */

const person = (over: Record<string, unknown> = {}) => ({
  closed_by: 'u1',
  email: 'sara@dev.local',
  sessions: 4,
  net: -30,
  short_nights: 3,
  over_nights: 1,
  short_rate: 75,
  worst_short: -20,
  ...over,
});

const history = (over: Record<string, unknown> = {}) => ({
  from: new Date().toISOString(),
  to: new Date().toISOString(),
  sessions: [],
  people: [person()],
  summary: { closed: 9, balanced: 4, out: 5, net: -50, total_short: -70 },
  ...over,
});

const show = (body: unknown) => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: body } as never);
  return render(<CashUpHistory from={new Date(Date.now() - 86400_000)} to={new Date()} />);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the period', () => {
  it('counts what balanced against what was counted at all', async () => {
    show(history());

    expect(await screen.findByTestId('balanced')).toHaveTextContent('4');
    expect(screen.getByTestId('closed')).toHaveTextContent('9');
  });

  it('shows the money that went missing, not only the net', async () => {
    // Net is -50; -70 actually left the drawer, because a night that came in
    // over masks one of the shortfalls. Net alone says the month was better
    // than it was.
    show(history());

    const short = await screen.findByTestId('short');
    expect(short).toHaveTextContent('70.00');
    expect(short).toHaveTextContent('50.00');
  });

  it('says nothing was counted rather than reporting a tidy zero', async () => {
    // "0 عجز" and "no drawer was ever counted" are different facts, and only
    // one of them is reassuring.
    show(
      history({
        people: [],
        summary: { closed: 0, balanced: 0, out: 0, net: 0, total_short: 0 },
      }),
    );

    expect(await screen.findByText(/لم يُغلق أي درج/)).toBeInTheDocument();
    expect(screen.queryByTestId('short')).not.toBeInTheDocument();
  });
});

describe('naming people without accusing them', () => {
  it('never shows a count without its denominator', async () => {
    // "Short 3 times" is meaningless until you know it was 3 of 4 and not
    // 3 of 90.
    show(history());

    const row = await screen.findByTestId('person-u1');
    expect(row).toHaveTextContent('3 / 4');
  });

  it('separates somebody short once from somebody short constantly', async () => {
    show(
      history({
        people: [
          person({ closed_by: 'many', email: 'many@x', sessions: 20, short_nights: 3, short_rate: 15, net: -30 }),
          person({ closed_by: 'few', email: 'few@x', sessions: 3, short_nights: 3, short_rate: 100, net: -30 }),
        ],
      }),
    );

    await screen.findByTestId('person-many');
    // Identical short_nights and identical net; the rate is the only thing
    // that tells the two apart, so it has to be on screen.
    expect(screen.getByTestId('person-many')).toHaveTextContent('15%');
    expect(screen.getByTestId('person-few')).toHaveTextContent('100%');
  });

  it('does not colour a person red however bad they look', async () => {
    // The one accent on this screen is on a TOTAL, never on somebody's row.
    // A red name is read as a verdict.
    show(history({ people: [person({ net: -900, short_nights: 4, short_rate: 100 })] }));

    const row = await screen.findByTestId('person-u1');
    expect(row.querySelector('.text-sunset-600')).toBeNull();
  });

  it('keeps the order the server sent, rather than sorting by who looks worst', async () => {
    // The server orders by drawers closed. Re-sorting here by variance would
    // rebuild the ranking of suspicion the API deliberately refuses to make.
    show(
      history({
        people: [
          person({ closed_by: 'first', email: 'a@x', sessions: 10, net: -5 }),
          person({ closed_by: 'second', email: 'b@x', sessions: 2, net: -500 }),
        ],
      }),
    );

    await screen.findByTestId('person-first');
    const rows = screen.getAllByTestId(/^person-/).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['person-first', 'person-second']);
  });

  it('says so when the account behind a session is gone', async () => {
    // The session still happened. Dropping the row would quietly shrink the
    // totals; inventing a name would be worse.
    show(history({ people: [person({ closed_by: 'ghost', email: null })] }));

    expect(await screen.findByTestId('person-ghost')).toHaveTextContent('حساب محذوف');
  });

  it('distinguishes that from money nobody was recorded for', async () => {
    show(history({ people: [person({ closed_by: null, email: null })] }));

    expect(await screen.findByTestId('person-unattributed')).toHaveTextContent('غير منسوب');
  });
});

describe('when it cannot load', () => {
  it('costs one card, not the dashboard it sits on', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network'));
    render(<CashUpHistory from={new Date(Date.now() - 86400_000)} to={new Date()} />);

    await waitFor(() =>
      expect(screen.getByText('تعذّر تحميل سجلّ الجرد.')).toBeInTheDocument(),
    );
  });

  it('treats a malformed payload the same way', async () => {
    show({});
    await waitFor(() =>
      expect(screen.getByText('تعذّر تحميل سجلّ الجرد.')).toBeInTheDocument(),
    );
  });
});
