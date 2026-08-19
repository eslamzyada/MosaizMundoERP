import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Storefront, { TrackOrder } from './Storefront';

/**
 * The customer's page.
 *
 * The one that matters is the second test. This page KNOWS the prices — it read
 * them from the menu to show a running total — and it must still not send them.
 * The server prices every line again from the same menu, and a page that could
 * name a price would be a page worth tampering with.
 */

const menu = {
  restaurant: 'مطعم الاختبار',
  greeting: 'أهلًا',
  items: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'كشري', price: 45 },
    { id: '22222222-2222-4222-8222-222222222222', name: 'فتّة', price: 80 },
  ],
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const notFound = () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) });

const showShop = () =>
  render(
    <MemoryRouter initialEntries={['/order/test-shop']}>
      <Routes>
        <Route path="/order/:slug" element={<Storefront />} />
      </Routes>
    </MemoryRouter>,
  );

describe('the menu', () => {
  it('shows what the restaurant is offering', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    showShop();

    expect(await screen.findByText('مطعم الاختبار')).toBeInTheDocument();
    expect(screen.getByText('كشري')).toBeInTheDocument();
    expect(screen.getByText('80.00 ج.م')).toBeInTheDocument();
  });

  it('says one useful thing when the shop is not available', async () => {
    // 404 covers unknown, closed, and "does not do this" — the page cannot
    // tell them apart and should not pretend to.
    fetchMock.mockResolvedValue(notFound());
    showShop();

    expect(await screen.findByText('الطلب غير متاح حاليًا')).toBeInTheDocument();
  });

  it('does not send credentials — a customer has none', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    showShop();
    await screen.findByText('كشري');

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers?.Authorization).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });
});

describe('placing an order', () => {
  it('THE ONE THAT MATTERS: sends ids and quantities, never a price', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    const user = userEvent.setup();
    showShop();

    await user.click(await screen.findByLabelText('إضافة كشري'));
    await user.click(screen.getByLabelText('إضافة كشري'));
    await user.click(screen.getByLabelText('إضافة فتّة'));

    await user.type(screen.getByLabelText('الاسم'), 'أحمد');
    await user.type(screen.getByLabelText('رقم الهاتف'), '01000000000');

    fetchMock.mockResolvedValue(ok({ tracking_token: 'tok-1' }));
    await user.click(screen.getByTestId('place-order'));

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const body = JSON.parse(post[1].body);

    expect(body.items).toEqual([
      { item_id: menu.items[0].id, quantity: 2 },
      { item_id: menu.items[1].id, quantity: 1 },
    ]);

    // Not a price anywhere in the payload, under any spelling.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('price');
    expect(raw).not.toContain('45');
    expect(raw).not.toContain('total');
  });

  it('shows a running total, and says the server decides the real one', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    const user = userEvent.setup();
    showShop();

    await user.click(await screen.findByLabelText('إضافة كشري'));
    await user.click(screen.getByLabelText('إضافة فتّة'));

    expect(screen.getByTestId('basket-total')).toHaveTextContent('125.00');
    expect(screen.getByText(/يُحسب المبلغ النهائي من قائمة المطعم/)).toBeInTheDocument();
  });

  it('demands a name and a phone before sending anything', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    const user = userEvent.setup();
    showShop();

    await user.click(await screen.findByLabelText('إضافة كشري'));
    await user.click(screen.getByTestId('place-order'));

    expect(await screen.findByText('من فضلك اكتب اسمك.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0);
  });

  it('gives the customer their tracking link', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    const user = userEvent.setup();
    showShop();

    await user.click(await screen.findByLabelText('إضافة كشري'));
    await user.type(screen.getByLabelText('الاسم'), 'أحمد');
    await user.type(screen.getByLabelText('رقم الهاتف'), '01000000000');

    fetchMock.mockResolvedValue(ok({ tracking_token: 'abc-123' }));
    await user.click(screen.getByTestId('place-order'));

    const placed = await screen.findByTestId('order-placed');
    expect(within(placed).getByText(/abc-123/)).toBeInTheDocument();
  });

  it('a basket with nothing in it offers no form at all', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    showShop();
    await screen.findByText('كشري');

    expect(screen.queryByTestId('place-order')).not.toBeInTheDocument();
  });
});

describe('tracking', () => {
  const showTrack = () =>
    render(
      <MemoryRouter initialEntries={['/order/track/abc-123']}>
        <Routes>
          <Route path="/order/track/:token" element={<TrackOrder />} />
        </Routes>
      </MemoryRouter>,
    );

  it('says what happened in words, not a status code', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'accepted', total: 90 }));
    showTrack();

    expect(await screen.findByText('تم قبول طلبك')).toBeInTheDocument();
  });

  it('an unknown token says so plainly', async () => {
    fetchMock.mockResolvedValue(notFound());
    showTrack();

    await waitFor(() => expect(screen.getByText('لم نجد هذا الطلب.')).toBeInTheDocument());
  });
});

describe('tapping + quickly', () => {
  /**
   * Found by clicking three times in a browser and getting a quantity of one.
   *
   * The handler used to read the quantity out of the render closure, so three
   * taps inside one React batch all saw the same stale basket, all set the
   * quantity to 1, and the customer who wanted three burgers got one. userEvent
   * awaits a re-render between clicks and therefore cannot reproduce it —
   * fireEvent, fired synchronously, is what a fast thumb actually does.
   */
  it('counts every tap, not just the last render', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    showShop();
    const add = await screen.findByLabelText('إضافة كشري');

    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(add);

    expect(await screen.findByTestId('basket-total')).toHaveTextContent('135.00');
  });

  it('and every tap down again, without going negative', async () => {
    fetchMock.mockResolvedValue(ok(menu));
    showShop();
    const add = await screen.findByLabelText('إضافة كشري');
    const remove = screen.getByLabelText('إنقاص كشري');

    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(remove);
    fireEvent.click(remove);
    fireEvent.click(remove);

    // Back to nothing, and the form is gone with it — not stuck at -1.
    await waitFor(() => expect(screen.queryByTestId('place-order')).not.toBeInTheDocument());
  });
});

/**
 * A tracking page has to keep asking.
 *
 * It fetched once. The status it exists to display is exactly the thing that
 * changes after the page loads — so a customer watching it saw "awaiting the
 * restaurant" through acceptance, preparation and delivery, with nothing on
 * screen even hinting they should reload.
 */
describe('TrackOrder keeps asking', () => {
  const token = 'c0ffee00-0000-4000-8000-000000000001';

  const renderTrack = () =>
    render(
      <MemoryRouter initialEntries={[`/order/track/${token}`]}>
        <Routes>
          <Route path="/order/track/:token" element={<TrackOrder />} />
        </Routes>
      </MemoryRouter>,
    );

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks again while the order is still pending', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'pending', total: 90 }) })
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'accepted', total: 90 }) });
    vi.stubGlobal('fetch', fetchMock);

    renderTrack();
    expect(await screen.findByText('بانتظار تأكيد المطعم')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // The whole point: the customer sees the change without touching anything.
    expect(await screen.findByText('تم قبول طلبك')).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('stops asking once the order is settled', async () => {
    // Polling a delivered order is a request every 15 seconds, forever, from a
    // page somebody left open on a counter.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'fulfilled', total: 90 }) });
    vi.stubGlobal('fetch', fetchMock);

    renderTrack();
    expect(await screen.findByText('تم التسليم')).toBeInTheDocument();
    const afterFirst = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it('a failed poll does NOT tell the customer their order is gone', async () => {
    // The bug polling would have introduced. One dropped request must not
    // replace a real order with "we could not find this".
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'pending', total: 90 }) })
      .mockRejectedValue(new Error('network blip'));
    vi.stubGlobal('fetch', fetchMock);

    renderTrack();
    expect(await screen.findByText('بانتظار تأكيد المطعم')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.queryByText('لم نجد هذا الطلب.')).not.toBeInTheDocument();
    expect(screen.getByText('بانتظار تأكيد المطعم')).toBeInTheDocument();
  });

  it('still reports a token that never resolved', async () => {
    // The first answer, and only the first, may decide the order is not there.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no such order')));
    renderTrack();
    expect(await screen.findByText('لم نجد هذا الطلب.')).toBeInTheDocument();
  });

  it('shows when the order was placed', async () => {
    // The API always returned placed_at and the page threw it away, so a
    // customer could not tell this order from one placed yesterday.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'pending',
          total: 90,
          placed_at: '2026-08-18T22:13:53.528Z',
        }),
      }),
    );

    renderTrack();
    await screen.findByText('بانتظار تأكيد المطعم');
    expect(screen.getByTestId('track').textContent).toMatch(/\d/);
  });
});
