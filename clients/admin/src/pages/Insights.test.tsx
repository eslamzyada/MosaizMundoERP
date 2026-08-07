import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Insights from './Insights';
import { apiClient } from '../api/client';

/**
 * The dashboard as a whole.
 *
 * The charts are tested next to their own maths; what only this can prove is
 * the page's one structural promise — **every card fails on its own**. Five
 * reports are fetched, and a dashboard that blanks entirely because one of them
 * timed out is down more often than the system it is reporting on. There is no
 * way to see that from a screenshot of it working.
 *
 * The service summary sits at the TOP, which makes it the one most able to take
 * the page down with it — so it gets the same treatment as the rest.
 */

interface Stub {
  trends?: unknown;
  waste?: unknown;
  purchasing?: unknown;
  assets?: unknown;
  employees?: unknown;
  fail?: string[];
}

const point = (day: string, over: Record<string, number> = {}) => ({
  bucket_start: day,
  revenue: 0,
  costed_revenue: 0,
  cogs: 0,
  gross_profit: 0,
  order_count: 0,
  waste_cost: 0,
  write_off_cost: 0,
  purchasing_cost: 0,
  ...over,
});

const TRENDS = {
  from: '2026-07-01',
  to: '2026-07-03',
  days: 3,
  bucket: 'day',
  summary: {
    revenue: 1500,
    costed_revenue: 1500,
    cogs: 600,
    gross_profit: 900,
    margin_pct: 60,
    coverage_pct: 100,
    order_count: 12,
    average_ticket: 125,
    waste_cost: 80,
    write_off_cost: 95,
    waste_share_pct: 11.8,
    purchasing_cost: 400,
    bucket_count: 3,
  },
  points: [
    point('2026-07-01', { revenue: 500, gross_profit: 300, order_count: 4 }),
    point('2026-07-02', { waste_cost: 80, write_off_cost: 95 }),
    point('2026-07-03', { revenue: 1000, gross_profit: 600, order_count: 8, purchasing_cost: 400 }),
  ],
};

const WASTE = {
  from: '2026-07-01',
  to: '2026-07-03',
  days: 3,
  summary: {
    write_off_cost: 95,
    waste_cost: 80,
    staff_meal_cost: 15,
    other_cost: 0,
    cogs: 600,
    waste_share_pct: 11.8,
    write_off_count: 3,
    exceeded_recorded_stock_count: 0,
  },
  by_reason: [
    { reason: 'expired', is_waste: true, write_off_count: 2, quantity: 4, cost: 80, exceeded_recorded_stock_count: 0 },
    { reason: 'staff_meal', is_waste: false, write_off_count: 1, quantity: 1, cost: 15, exceeded_recorded_stock_count: 0 },
  ],
  by_item: [
    { id: 'ing-1', name: 'طماطم', unit_of_measure: 'kg', write_off_count: 2, quantity: 4, cost: 80 },
  ],
  by_supplier: [],
};

const PURCHASING = {
  from: '2026-07-01',
  to: '2026-07-03',
  days: 3,
  summary: {
    committed: 400,
    received: 300,
    outstanding: 100,
    fulfilment_pct: 75,
    order_count: 2,
    supplier_count: 1,
    open_orders: { order_count: 1, outstanding: 100, oldest_placed_at: '2026-06-01T09:00:00.000Z' },
  },
  by_supplier: [
    { id: 'sup-1', name: 'مورّد الشام', is_active: true, order_count: 2, committed: 400, received: 300, outstanding: 100 },
  ],
  by_status: [
    { status: 'placed', order_count: 1, committed: 400 },
    { status: 'draft', order_count: 1, committed: 90 },
  ],
  by_item: [],
};

const ASSETS = {
  from: '2026-07-01',
  to: '2026-07-03',
  days: 3,
  summary: {
    capital_tied_up: 2000,
    stock_consumed_cost: 600,
    turnover: 0.3,
    dead_capital: 150,
    dead_capital_pct: 7.5,
    has_usage_data: true,
    window_days: 3,
  },
  by_item: [
    { id: 'ing-1', name: 'طماطم', unit_of_measure: 'kg', is_active: true, on_hand: 20, capital: 1200, capital_share_pct: 60, days_held: 4, consumed_quantity: 5, consumed_cost: 300, days_of_cover: 12, is_dead_stock: false },
    { id: 'ing-2', name: 'زيت', unit_of_measure: 'L', is_active: true, on_hand: 10, capital: 800, capital_share_pct: 40, days_held: 9, consumed_quantity: 2, consumed_cost: 300, days_of_cover: 15, is_dead_stock: false },
  ],
};

const EMPLOYEES = {
  from: '2026-07-01',
  to: '2026-07-03',
  days: 3,
  team: {
    headcount: 2,
    orders_served: 12,
    revenue: 1500,
    average_orders_per_person: 6,
    average_revenue_per_person: 750,
    average_order_value: 125,
    void_rate_pct: 0,
  },
  unattributed: { orders_served: 0, revenue: 0, present: false },
  employees: [
    { user_id: 'u-1', email: 'sara@dev.local', role: 'cashier', is_active: true, orders_served: 8, revenue: 1000, average_order_value: 125, voided_orders: 0, voided_value: 0, void_rate_pct: 0, revenue_share_pct: 66.7 },
  ],
};

const SERVICE = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-07-03T00:00:00.000Z',
  revenue: 1500,
  orders: 12,
  labour: { minutes: 600, hours: 10, cost: 300, uncosted_entries: 0, share_of_revenue: 20 },
  // Null means this tenant does not run those, which is the default for a new
  // one — the page must render without them.
  covers: null,
  online: null,
};

/** Routes each report to its stub, and fails only the ones named. */
function stubApi({ fail = [] }: Stub = {}) {
  return vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    const which = url.replace('/api/reports/', '');
    if (fail.includes(which)) {
      return Promise.reject(
        Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500 } }),
      ) as never;
    }
    const body: Record<string, unknown> = {
      trends: TRENDS,
      waste: WASTE,
      purchasing: PURCHASING,
      'inventory-assets': ASSETS,
      employees: EMPLOYEES,
      service: SERVICE,
    };
    return Promise.resolve({ data: body[which] ?? {} }) as never;
  });
}

function Here() {
  const { pathname, search } = useLocation();
  return <span data-testid="here">{pathname + search}</span>;
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/insights']}>
      <Insights />
      <Routes>
        <Route path="*" element={<Here />} />
      </Routes>
    </MemoryRouter>,
  );

/** The card with this heading, so an assertion cannot match text in another one. */
const card = (title: string) => screen.getByRole('heading', { name: title }).closest('section')!;

beforeEach(() => {
  vi.stubGlobal('print', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the headline figures', () => {
  it('shows what the period made', async () => {
    stubApi();
    renderPage();

    expect(await screen.findByText('1,500.00')).toBeInTheDocument();
    expect(screen.getByText('هامش 60%')).toBeInTheDocument();
  });

  it('colours a LOSS differently from a small profit', async () => {
    // A minus sign in a column of numbers is easy to read straight past.
    vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
      const which = url.replace('/api/reports/', '');
      const body: Record<string, unknown> = {
        // Same fixtures as everywhere else, with the one figure changed. A
        // hand-trimmed stub here would be testing a response shape the API
        // never sends.
        trends: { ...TRENDS, summary: { ...TRENDS.summary, gross_profit: -250 } },
        waste: WASTE,
        purchasing: PURCHASING,
        'inventory-assets': ASSETS,
        employees: EMPLOYEES,
        service: SERVICE,
      };
      return Promise.resolve({ data: body[which] ?? {} }) as never;
    });
    renderPage();

    const loss = await screen.findByText('-250.00');
    expect(loss.className).toMatch(/rose/);
  });
});

describe('every card fails on its own', () => {
  it('draws the other four when the waste report dies', async () => {
    stubApi({ fail: ['waste'] });
    renderPage();

    // The failed card says what went wrong...
    await waitFor(() =>
      expect(within(card('أسباب الهدر')).getByText(/خطأ في الخادم \(500\)/)).toBeInTheDocument(),
    );
    // ...and the ones that loaded are still drawn.
    expect(within(card('الإيراد ومجمل الربح')).getByRole('img')).toBeInTheDocument();
    expect(within(card('أكبر المورّدين')).getByText('مورّد الشام')).toBeInTheDocument();
  });

  it('draws the rest when the TRENDS report dies — the biggest one', async () => {
    // Four of the six charts read from trends. Losing it must still leave the
    // purchasing, stock and staff cards standing.
    stubApi({ fail: ['trends'] });
    renderPage();

    await waitFor(() => expect(screen.getAllByText(/خطأ في الخادم/).length).toBeGreaterThan(0));
    expect(within(card('أكبر المورّدين')).getByText('مورّد الشام')).toBeInTheDocument();
    expect(within(card('رأس المال في المخزون')).getByText('طماطم')).toBeInTheDocument();
  });

  it('draws the whole page when the SERVICE summary dies, though it is first', async () => {
    // It renders above everything else, so a crash inside it blanks what
    // follows. It has to fail in its own box like every other card.
    stubApi({ fail: ['service'] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText('تعذّر تحميل ملخّص الخدمة.')).toBeInTheDocument(),
    );
    expect(within(card('الإيراد ومجمل الربح')).getByRole('img')).toBeInTheDocument();
    expect(within(card('رأس المال في المخزون')).getByText('طماطم')).toBeInTheDocument();
  });

  it('says a card is EMPTY differently from saying it failed', async () => {
    // "no waste this week" is good news; "the report did not load" is not.
    // One message for both makes them indistinguishable.
    vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
      if (url.endsWith('/waste')) {
        return Promise.resolve({
          data: { ...WASTE, by_reason: [], by_item: [] },
        }) as never;
      }
      const which = url.replace('/api/reports/', '');
      const body: Record<string, unknown> = {
        trends: TRENDS,
        purchasing: PURCHASING,
        'inventory-assets': ASSETS,
        employees: EMPLOYEES,
        service: SERVICE,
      };
      return Promise.resolve({ data: body[which] ?? {} }) as never;
    });
    renderPage();

    await waitFor(() =>
      expect(within(card('أسباب الهدر')).getByText('لم يُسجَّل أي إهلاك.')).toBeInTheDocument(),
    );
    expect(within(card('أسباب الهدر')).queryByText(/خطأ/)).not.toBeInTheDocument();
  });
});

describe('the charts', () => {
  it('draws the revenue and profit series', async () => {
    stubApi();
    renderPage();

    const chart = await screen.findByRole('img', { name: 'الإيراد ومجمل الربح عبر الفترة' });
    // Two series: the shaded revenue area, its line, and the profit line.
    expect(chart.querySelectorAll('path').length).toBeGreaterThanOrEqual(3);
  });

  it('ranks suppliers and ingredients', async () => {
    stubApi();
    renderPage();

    await waitFor(() => expect(screen.getByTestId('bar-sup-1')).toBeInTheDocument());
    // Sorted by capital: طماطم (1200) before زيت (800).
    const stock = within(card('رأس المال في المخزون')).getAllByRole('listitem');
    expect(stock[0]).toHaveTextContent('طماطم');
  });

  it('shows the open orders that are NOT in the window', async () => {
    stubApi();
    renderPage();

    await waitFor(() =>
      expect(within(card('طلبات لم تصل بعد')).getByText('100.00')).toBeInTheDocument(),
    );
    expect(within(card('طلبات لم تصل بعد')).getByText('2026-06-01')).toBeInTheDocument();
  });
});

describe('getting from a chart to the record', () => {
  it('a supplier bar opens that supplier', async () => {
    stubApi();
    renderPage();

    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByTestId('bar-sup-1')).toBeInTheDocument());
    await user.click(within(screen.getByTestId('bar-sup-1')).getByRole('button'));

    // ?focus= is what makes the suppliers page scroll to the row rather than
    // just being the page it is on.
    expect(screen.getByTestId('here')).toHaveTextContent('/suppliers?focus=sup-1');
  });

  it('a wasted ingredient opens that ingredient', async () => {
    stubApi();
    renderPage();

    const user = userEvent.setup();
    const bars = await screen.findAllByTestId('bar-ing-1');
    await user.click(within(bars[0]).getByRole('button'));

    expect(screen.getByTestId('here')).toHaveTextContent('/inventory?focus=ing-1');
  });
});

describe('choosing the period', () => {
  it('re-asks the server when the window changes', async () => {
    const get = stubApi();
    renderPage();
    await screen.findByText('1,500.00');

    const user = userEvent.setup();
    get.mockClear();
    await user.click(screen.getByRole('button', { name: '٧ أيام' }));

    await waitFor(() => expect(get).toHaveBeenCalled());
    const trendsCall = get.mock.calls.find(([url]) => String(url).endsWith('/trends'));
    expect(trendsCall?.[1]).toMatchObject({ params: { days: 7 } });
  });

  it('asks for a WIDER bucket, rather than regrouping in the browser', async () => {
    // Regrouping client-side would have to re-derive week boundaries the
    // database already knows, and the two would drift on the first edge case.
    const get = stubApi();
    renderPage();
    await screen.findByText('1,500.00');

    const user = userEvent.setup();
    get.mockClear();
    await user.click(screen.getByRole('button', { name: 'شهري' }));

    await waitFor(() => {
      const call = get.mock.calls.find(([url]) => String(url).endsWith('/trends'));
      expect(call?.[1]).toMatchObject({ params: { bucket: 'month' } });
    });
  });
});
