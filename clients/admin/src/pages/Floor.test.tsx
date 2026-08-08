import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Floor from './Floor';
import { apiClient } from '../api/client';

/**
 * الصالة.
 *
 * This page used to be a list of open orders. Every assertion below is about
 * something that list could not show, or showed in the wrong order:
 *
 *   a table sitting with NOTHING ordered has no items, so it was invisible —
 *   and it is the most urgent thing in the building;
 *   a FREE table is not an order at all;
 *   a booking due on a table still eating is the only thing here that is about
 *   to become a problem rather than already being one.
 *
 * The ordering is the feature. A floor screen is read in three seconds while
 * walking past it, so what is wrong has to be at the top — a page that is
 * correct but sorted by time makes somebody read all of it.
 */

const tab = (over: Record<string, unknown> = {}) => ({
  id: `tab-${Math.random().toString(36).slice(2, 8)}`,
  opened_at: new Date().toISOString(),
  minutes_open: 10,
  total_amount: 100,
  item_count: 2,
  unfired_count: 0,
  note: null,
  ...over,
});

const table = (over: Record<string, unknown> = {}) => ({
  id: `t-${Math.random().toString(36).slice(2, 8)}`,
  label: 'طاولة',
  area: null,
  seats: 4,
  tab: null,
  next_reservation: null,
  ...over,
});

const show = (body: unknown) => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: body } as never);
  return render(<Floor />);
};

const labelsInOrder = () =>
  screen
    .getAllByTestId(/^table-/)
    .map((el) => within(el).getByText(/طاولة/).textContent);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the whole room', () => {
  it('shows a FREE table, which a list of orders never could', async () => {
    show({
      tables: [table({ id: 'free', label: 'طاولة فارغة' })],
      unseated_tabs: [],
      summary: { open_tabs: 0, unseated_tabs: 0, tables: 1, free: 1, occupied: 0 },
    });

    expect(await screen.findByTestId('table-free')).toBeInTheDocument();
    expect(screen.getByTestId('state-free')).toHaveTextContent('فارغة');
    expect(screen.getByTestId('count-free')).toHaveTextContent('1');
  });

  it('counts occupied against free, so the room is legible at a glance', async () => {
    show({
      tables: [table({ tab: tab() }), table()],
      unseated_tabs: [],
      summary: { open_tabs: 1, unseated_tabs: 0, tables: 2, free: 1, occupied: 1 },
    });

    await screen.findByTestId('floor-summary');
    expect(screen.getByTestId('count-occupied')).toHaveTextContent('1');
    expect(screen.getByTestId('count-free')).toHaveTextContent('1');
  });
});

describe('what is wrong, and in what order', () => {
  it('calls out a table sitting with NOTHING ordered', async () => {
    // The single most useful row on the screen, and the one a list of
    // orders-with-items could not contain, because it has none.
    show({
      tables: [table({ id: 'ignored', tab: tab({ item_count: 0, minutes_open: 22 }) })],
      unseated_tabs: [],
      summary: { open_tabs: 1, unseated_tabs: 0, tables: 1, free: 0, occupied: 1 },
    });

    const trouble = await screen.findByTestId('trouble-ignored');
    expect(trouble).toHaveTextContent('22');
    expect(trouble).toHaveTextContent('بلا طلب');
  });

  it('does NOT call out a table that has only just sat down', async () => {
    // Otherwise every table is urgent and the colour means nothing. A party
    // three minutes in with no order is a party reading a menu.
    show({
      tables: [table({ id: 'new', tab: tab({ item_count: 0, minutes_open: 3 }) })],
      unseated_tabs: [],
      summary: { open_tabs: 1, unseated_tabs: 0, tables: 1, free: 0, occupied: 1 },
    });

    await screen.findByTestId('table-new');
    expect(screen.queryByTestId('trouble-new')).not.toBeInTheDocument();
  });

  it('calls out lines the kitchen has not been told about', async () => {
    show({
      tables: [table({ id: 'unfired', tab: tab({ unfired_count: 3 }) })],
      unseated_tabs: [],
      summary: { open_tabs: 1, unseated_tabs: 0, tables: 1, free: 0, occupied: 1 },
    });

    expect(await screen.findByTestId('trouble-unfired')).toHaveTextContent('3');
  });

  it('puts an ignored table ABOVE an unfired one, and both above the calm', async () => {
    // The whole point of the page. A party nobody has spoken to outranks a
    // party somebody served but did not press send for.
    show({
      tables: [
        table({ id: 'calm', label: 'طاولة هادئة', tab: tab() }),
        table({ id: 'unfired', label: 'طاولة غير مرسلة', tab: tab({ unfired_count: 2 }) }),
        table({ id: 'ignored', label: 'طاولة متروكة', tab: tab({ item_count: 0, minutes_open: 30 }) }),
      ],
      unseated_tabs: [],
      summary: { open_tabs: 3, unseated_tabs: 0, tables: 3, free: 0, occupied: 3 },
    });

    await screen.findByTestId('table-ignored');
    expect(labelsInOrder()).toEqual(['طاولة متروكة', 'طاولة غير مرسلة', 'طاولة هادئة']);
  });

  it('puts FREE tables last — they are the only rows nobody must act on', async () => {
    show({
      tables: [
        table({ id: 'free', label: 'طاولة فارغة' }),
        table({ id: 'busy', label: 'طاولة مشغولة', tab: tab() }),
      ],
      unseated_tabs: [],
      summary: { open_tabs: 1, unseated_tabs: 0, tables: 2, free: 1, occupied: 1 },
    });

    await screen.findByTestId('table-free');
    expect(labelsInOrder()).toEqual(['طاولة مشغولة', 'طاولة فارغة']);
  });
});

describe('a booking arriving at a table that is still eating', () => {
  it('warns, and counts it', async () => {
    show({
      tables: [
        table({
          id: 'clash',
          tab: tab(),
          next_reservation: {
            id: 'r1',
            guest_name: 'ضيف',
            party_size: 2,
            starts_at: new Date().toISOString(),
            minutes_until: 30,
          },
        }),
      ],
      unseated_tabs: [],
      summary: { open_tabs: 1, unseated_tabs: 0, tables: 1, free: 0, occupied: 1, double_booked_soon: 1 },
    });

    expect(await screen.findByTestId('trouble-clash')).toHaveTextContent('30');
    expect(screen.getByTestId('count-double')).toHaveTextContent('1');
  });

  it('does not warn about a booking hours away', async () => {
    // A table due to turn over at nine is not a problem at six.
    show({
      tables: [
        table({
          id: 'later',
          tab: tab(),
          next_reservation: {
            id: 'r1',
            guest_name: 'ضيف',
            party_size: 2,
            starts_at: new Date().toISOString(),
            minutes_until: 180,
          },
        }),
      ],
      unseated_tabs: [],
      summary: { open_tabs: 1, unseated_tabs: 0, tables: 1, free: 0, occupied: 1, double_booked_soon: 0 },
    });

    await screen.findByTestId('table-later');
    expect(screen.queryByTestId('trouble-later')).not.toBeInTheDocument();
  });

  it('shows a free table who is coming to it, without calling it trouble', async () => {
    show({
      tables: [
        table({
          id: 'booked',
          next_reservation: {
            id: 'r1',
            guest_name: 'سلمى',
            party_size: 4,
            starts_at: new Date().toISOString(),
            minutes_until: 20,
          },
        }),
      ],
      unseated_tabs: [],
      summary: { open_tabs: 0, unseated_tabs: 0, tables: 1, free: 1, occupied: 0 },
    });

    const card = await screen.findByTestId('table-booked');
    expect(card).toHaveTextContent('سلمى');
    expect(screen.queryByTestId('trouble-booked')).not.toBeInTheDocument();
  });
});

describe('a restaurant with no floor plan', () => {
  it('says so, instead of reporting an empty room', async () => {
    // "0 tables free" told to a takeaway counter is false about itself.
    show({
      tables: null,
      unseated_tabs: [tab({ id: 'takeaway', note: 'تيك أواي' })],
      summary: { open_tabs: 1, unseated_tabs: 1 },
    });

    expect(await screen.findByTestId('no-floor-plan')).toBeInTheDocument();
    expect(screen.queryByTestId('floor-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('count-free')).not.toBeInTheDocument();
  });

  it('still shows the tabs it does have', async () => {
    show({
      tables: null,
      unseated_tabs: [tab({ id: 'takeaway', note: 'تيك أواي' })],
      summary: { open_tabs: 1, unseated_tabs: 1 },
    });

    expect(await screen.findByTestId('unseated-takeaway')).toHaveTextContent('تيك أواي');
  });

  it('an EMPTY floor plan is a different message from no floor plan', async () => {
    // A restaurant that runs tables but has not drawn any yet is told where to
    // draw them. Collapsing the two would send it to the wrong screen.
    show({
      tables: [],
      unseated_tabs: [],
      summary: { open_tabs: 0, unseated_tabs: 0, tables: 0, free: 0, occupied: 0 },
    });

    await screen.findByTestId('floor-summary');
    expect(screen.queryByTestId('no-floor-plan')).not.toBeInTheDocument();
    expect(screen.getByText(/تُضاف من شاشة الحجوزات/)).toBeInTheDocument();
  });
});

describe('when it cannot load', () => {
  it('says so and offers a retry, rather than an empty room', async () => {
    // An empty floor and a failed request look identical, and one of them
    // means "go home".
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network'));
    render(<Floor />);

    await waitFor(() => expect(screen.queryByTestId('floor-page')).not.toBeInTheDocument());
    expect(screen.queryByTestId('count-free')).not.toBeInTheDocument();
  });
});
