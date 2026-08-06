import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationBell from './NotificationBell';
import { apiClient } from '../api/client';

/**
 * The bell.
 *
 * The database decides who is told what; none of that is re-testable here. What
 * IS only true in this file:
 *
 *   1. The badge is the unread count the server reported — not a length, which
 *      would silently become "the last fifty" once a page fills up.
 *   2. Opening one takes you to it AND marks it read, in that order of intent:
 *      a click that navigates without clearing the badge leaves a permanent
 *      red dot on a job already done.
 *   3. A link that is not a path inside the admin is not followed. The database
 *      CHECK is the real gate; this is the second one, because a notification
 *      is a link somebody clicks without reading it.
 *   4. A failing poll does not blank the panel or shout. The inbox is nobody's
 *      actual job.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const notification = (over: Record<string, unknown> = {}) => ({
  id: 'n-1',
  kind: 'menu_change_proposed',
  subject: 'طلب تغيير في القائمة بانتظار قرارك',
  body: 'صنف جديد: سلطة الشيف — إضافة خيار خفيف',
  link: '/menu',
  actor_id: 'kitchen-1',
  read_at: null,
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});

const inbox = (unread: number, rows: unknown[]) =>
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { unread, notifications: rows } });

const show = () => render(<NotificationBell />, { wrapper: MemoryRouter });

beforeEach(() => {
  navigate.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the badge', () => {
  it('shows the count the server reported, not how many rows came back', async () => {
    // 3 unread, 1 row: the panel is a page, the badge is a total. Deriving one
    // from the other is wrong the moment the inbox is longer than a page.
    inbox(3, [notification()]);
    show();
    expect(await screen.findByTestId('unread-badge')).toHaveTextContent('3');
  });

  it('is absent when there is nothing to read', async () => {
    inbox(0, [notification({ read_at: new Date().toISOString() })]);
    show();
    await screen.findByTestId('notification-bell');
    await waitFor(() => expect(screen.queryByTestId('unread-badge')).not.toBeInTheDocument());
  });

  it('caps at 99+ rather than stretching the sidebar', async () => {
    inbox(412, [notification()]);
    show();
    expect(await screen.findByTestId('unread-badge')).toHaveTextContent('99+');
  });
});

describe('opening one', () => {
  it('marks it read and goes where it points', async () => {
    inbox(1, [notification()]);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    await user.click(await screen.findByTestId('notification-n-1'));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/notifications/n-1/read'));
    expect(navigate).toHaveBeenCalledWith('/menu');
  });

  it('still navigates when marking read fails', async () => {
    // Already read in another tab. Refusing to navigate would make the app
    // look broken over something that does not matter.
    inbox(1, [notification()]);
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('404'));
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    await user.click(await screen.findByTestId('notification-n-1'));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/menu'));
  });

  it('does NOT follow a link that leaves the admin', async () => {
    inbox(1, [notification({ link: 'https://example.com/pay' })]);
    vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    await user.click(await screen.findByTestId('notification-n-1'));

    await waitFor(() => expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does NOT follow a protocol-relative link either', async () => {
    // '//evil.example' is a URL, not a path, and startsWith('/') alone lets it
    // through.
    inbox(1, [notification({ link: '//evil.example/menu' })]);
    vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    await user.click(await screen.findByTestId('notification-n-1'));

    await waitFor(() => expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('one with nowhere to go simply closes the panel', async () => {
    inbox(1, [notification({ link: null })]);
    vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    await user.click(await screen.findByTestId('notification-n-1'));

    await waitFor(() => expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('the panel', () => {
  it('shows the subject and the detail', async () => {
    inbox(1, [notification()]);
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    expect(screen.getByText('طلب تغيير في القائمة بانتظار قرارك')).toBeInTheDocument();
    expect(screen.getByText(/سلطة الشيف/)).toBeInTheDocument();
  });

  it('says so when there is nothing, rather than showing an empty box', async () => {
    inbox(0, []);
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    expect(screen.getByText('لا توجد إشعارات')).toBeInTheDocument();
  });

  it('offers "mark all" only when something is unread', async () => {
    inbox(0, [notification({ read_at: new Date().toISOString() })]);
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    expect(screen.queryByText('تعليم الكل كمقروء')).not.toBeInTheDocument();
  });

  it('mark-all clears the badge', async () => {
    const get = inbox(2, [notification(), notification({ id: 'n-2' })]);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    get.mockResolvedValue({ data: { unread: 0, notifications: [] } });
    await user.click(screen.getByText('تعليم الكل كمقروء'));

    expect(post).toHaveBeenCalledWith('/api/notifications/read-all');
    await waitFor(() => expect(screen.queryByTestId('unread-badge')).not.toBeInTheDocument());
  });

  it('closes on Escape', async () => {
    inbox(1, [notification()]);
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByTestId('notification-bell'));
    expect(screen.getByTestId('notification-panel')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('notification-panel')).not.toBeInTheDocument();
  });
});

describe('when the server is unreachable', () => {
  it('keeps quiet in the chrome and explains inside the panel', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    show();

    // No badge shouting at somebody who cannot do anything about it.
    await waitFor(() => expect(screen.queryByTestId('unread-badge')).not.toBeInTheDocument());

    await user.click(screen.getByTestId('notification-bell'));
    expect(screen.getByText(/تعذّر تحديث الإشعارات/)).toBeInTheDocument();
  });
});
