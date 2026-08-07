import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Reservations from './Reservations';
import { apiClient } from '../api/client';
import * as session from '../session/SessionProvider';

/**
 * Seating, from the host's side (0043).
 *
 * The two 409s are the point. A host with a guest standing in front of them
 * needs to know WHICH problem they have — the table is occupied, or somebody
 * already cancelled the booking — because the fixes are different and only one
 * of them involves the guest waiting.
 */

const table = { id: 't-1', label: 'طاولة ٧', area: null, seats: 4, is_active: true };

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  table_id: 't-1',
  guest_name: 'أحمد',
  guest_phone: null,
  party_size: 4,
  starts_at: new Date().toISOString(),
  ends_at: new Date(Date.now() + 7200_000).toISOString(),
  status: 'booked',
  note: null,
  seated_order_id: null,
  ...over,
});

function stub(bookings: unknown[] = [booking()]) {
  vi.spyOn(session, 'useSession').mockReturnValue({
    me: { user_id: 'u1', organization_id: 'o1', role: 'waiter', modules: ['reservations'] },
    loading: false,
    error: false,
    reload: vi.fn(),
    can: () => false,
  } as unknown as ReturnType<typeof session.useSession>);

  vi.spyOn(apiClient, 'get').mockImplementation((url: string) => {
    if (url.includes('/tables')) return Promise.resolve({ data: [table] } as never);
    if (url.includes('availability')) return Promise.resolve({ data: { free: true } } as never);
    return Promise.resolve({ data: bookings } as never);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('seating a party', () => {
  it('is one action, not a status change', async () => {
    stub();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { order_id: 'o-9' } } as never);
    const user = userEvent.setup();
    render(<Reservations />);

    await user.click(await screen.findByTestId('seat-r-1'));

    // The seat endpoint, which opens the tab too — NOT /status.
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/reservations/r-1/seat'));
    expect(post.mock.calls.some(([url]) => String(url).includes('/status'))).toBe(false);
  });

  it('an occupied table says so, and says what to do', async () => {
    stub();
    vi.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'table_occupied' } },
    });
    const user = userEvent.setup();
    render(<Reservations />);

    await user.click(await screen.findByTestId('seat-r-1'));

    expect(await screen.findByText(/عليها حساب مفتوح/)).toBeInTheDocument();
  });

  it('a booking that is no longer waiting gets a DIFFERENT sentence', async () => {
    stub();
    vi.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'not_seatable' } },
    });
    const user = userEvent.setup();
    render(<Reservations />);

    await user.click(await screen.findByTestId('seat-r-1'));

    expect(await screen.findByText(/لم يعد في انتظار الإجلاس/)).toBeInTheDocument();
    expect(screen.queryByText(/عليها حساب مفتوح/)).not.toBeInTheDocument();
  });

  it('a party already sitting is not offered the button again', async () => {
    stub([booking({ status: 'seated', seated_order_id: 'o-9' })]);
    render(<Reservations />);

    await screen.findByTestId('booking-r-1');
    expect(screen.queryByTestId('seat-r-1')).not.toBeInTheDocument();
    expect(screen.getByText('حساب مفتوح')).toBeInTheDocument();
  });
});
