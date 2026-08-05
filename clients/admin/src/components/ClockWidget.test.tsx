import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClockWidget from './ClockWidget';
import { apiClient } from '../api/client';
import * as session from '../session/SessionProvider';

/**
 * Clocking in and out.
 *
 * Three things matter here and none of them is "the button calls the API":
 *
 *   1. A restaurant that does not run labour must see NOTHING — not a broken
 *      control, not an error. The 409 is the answer, and the answer is silence.
 *   2. The elapsed time is computed from the server's `since`. A device with a
 *      wrong clock must still show the right number of minutes.
 *   3. A 409 on the toggle means another device already changed the state.
 *      Re-read rather than argue with it.
 */

function stubSession(modules: string[] | undefined = ['labour']) {
  vi.spyOn(session, 'useSession').mockReturnValue({
    me: { user_id: 'u1', organization_id: 'o1', role: 'waiter', modules },
    loading: false,
    error: false,
    reload: vi.fn(),
    can: () => false,
  } as unknown as ReturnType<typeof session.useSession>);
}


afterEach(() => {
  vi.restoreAllMocks();
});

const clockState = (over: Record<string, unknown> = {}) => ({
  clocked_in: false,
  since: null,
  id: null,
  ...over,
});

describe('when the restaurant does not run labour', () => {
  it('renders nothing at all', async () => {
    stubSession([]);
    vi.spyOn(apiClient, 'get').mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'module_disabled' } },
    });
    const { container } = render(<ClockWidget />);

    await waitFor(() => expect(container.querySelector('[data-testid="clock-widget"]')).toBeNull());
  });
});

describe('the clock', () => {
  it('offers حضور when you are not clocked in', async () => {
    stubSession();
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: clockState() });
    render(<ClockWidget />);

    expect(await screen.findByTestId('clock-toggle')).toHaveTextContent('حضور');
  });

  it('clocking in posts to clock-in and re-reads the state', async () => {
    stubSession();
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: clockState() });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ClockWidget />);

    await user.click(await screen.findByTestId('clock-toggle'));

    expect(post).toHaveBeenCalledWith('/api/labour/clock-in', {});
    // Re-read, not an optimistic flip: the server decides what the clock says.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('shows minutes counted from the SERVER time, not from a local start', async () => {
    // A device 3 hours ahead must still say 45 minutes.
    const since = new Date(Date.now() - 45 * 60_000).toISOString();
    stubSession();
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: clockState({ clocked_in: true, since, id: 'e1' }),
    });
    render(<ClockWidget />);

    const toggle = await screen.findByTestId('clock-toggle');
    expect(toggle).toHaveTextContent('انصراف');
    expect(toggle).toHaveTextContent('45 د');
  });

  it('shows hours and minutes past the hour', async () => {
    const since = new Date(Date.now() - 130 * 60_000).toISOString();
    stubSession();
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: clockState({ clocked_in: true, since, id: 'e1' }),
    });
    render(<ClockWidget />);

    expect(await screen.findByTestId('clock-toggle')).toHaveTextContent('2 س 10 د');
  });

  it('clocking out posts to clock-out', async () => {
    stubSession();
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: clockState({ clocked_in: true, since: new Date().toISOString(), id: 'e1' }),
    });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: { minutes: 12 } });
    const user = userEvent.setup();
    render(<ClockWidget />);

    await user.click(await screen.findByTestId('clock-toggle'));
    expect(post).toHaveBeenCalledWith('/api/labour/clock-out');
  });

  it('a 409 means another device won — say so and re-read', async () => {
    stubSession();
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: clockState() });
    vi.spyOn(apiClient, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'clock_state' } },
    });
    const user = userEvent.setup();
    render(<ClockWidget />);

    await user.click(await screen.findByTestId('clock-toggle'));

    expect(await screen.findByText(/تغيّرت من جهاز آخر/)).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe('when the module is switched on while you are looking at it', () => {
  /**
   * The bug this exists for: the widget read its state once on mount. Switching
   * labour on in الإعدادات made the rota appear in the sidebar immediately —
   * because that comes from /api/me — while this stayed missing until a full
   * page reload. "It works after you refresh" is how people stop trusting a
   * screen.
   */
  it('appears without a page reload', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: clockState() });

    stubSession([]); // labour off
    const { rerender } = render(<ClockWidget />);
    await waitFor(() => expect(screen.queryByTestId('clock-widget')).not.toBeInTheDocument());
    expect(get).not.toHaveBeenCalled();

    stubSession(['labour']); // the owner switches it on
    rerender(<ClockWidget />);

    expect(await screen.findByTestId('clock-toggle')).toBeInTheDocument();
    expect(get).toHaveBeenCalled();
  });

  it('disappears again when it is switched off', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: clockState() });

    stubSession(['labour']);
    const { rerender } = render(<ClockWidget />);
    await screen.findByTestId('clock-toggle');

    stubSession([]);
    rerender(<ClockWidget />);
    await waitFor(() => expect(screen.queryByTestId('clock-widget')).not.toBeInTheDocument());
  });
});
