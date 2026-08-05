import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModulesPanel from './ModulesPanel';
import { apiClient } from '../api/client';
import * as session from '../session/SessionProvider';

/**
 * The screen where a tenant makes the ERP its own.
 *
 * What is worth pinning here is not "the toggle calls the API". It is:
 *
 *   1. Somebody who cannot change this still SEES it, disabled, with the
 *      reason. "Why can I not find الجرد" is answered better by a greyed
 *      switch than by an absence.
 *   2. A dependency refusal names the blocker rather than saying "failed".
 *   3. Flipping one reloads the session — the sidebar is built from /api/me,
 *      so without that you are left with a nav item that 409s when clicked.
 */

const modules = [
  {
    key: 'inventory',
    name: 'المخزون',
    description: 'المكوّنات الخام',
    depends_on: [],
    enforced_in: 'database',
    enabled: true,
  },
  {
    key: 'purchasing',
    name: 'المشتريات',
    description: 'المورّدون وأوامر الشراء',
    depends_on: ['inventory'],
    enforced_in: 'database',
    enabled: true,
  },
];

const reload = vi.fn();

function stubSession(role: string) {
  vi.spyOn(session, 'useSession').mockReturnValue({
    me: { user_id: 'u1', organization_id: 'o1', role, modules: ['inventory', 'purchasing'] },
    loading: false,
    error: false,
    reload,
    can: () => true,
  } as unknown as ReturnType<typeof session.useSession>);
}

afterEach(() => {
  vi.restoreAllMocks();
  reload.mockClear();
});

describe('who can change it', () => {
  it('an owner gets working switches', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    expect(within(row).getByRole('switch')).not.toBeDisabled();
  });

  it('a branch manager sees the same list, disabled, and is told why', async () => {
    // Hiding it would answer "why can I not find this" with silence.
    stubSession('branch_manager');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    expect(within(row).getByRole('switch')).toBeDisabled();
    expect(screen.getByText(/يغيّرها المالك أو المدير الإقليمي/)).toBeInTheDocument();
  });
});

describe('switching one', () => {
  it('sends the opposite of what it currently is', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    await user.click(within(row).getByRole('switch'));

    expect(put).toHaveBeenCalledWith('/api/modules/purchasing', { enabled: false });
  });

  it('reloads the session, because the sidebar is built from it', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    await user.click(within(row).getByRole('switch'));

    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('names the blocker when a dependency is in the way', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    vi.spyOn(apiClient, 'put').mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'module_dependency', blocked_by: 'purchasing' } },
    });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-inventory');
    await user.click(within(row).getByRole('switch'));

    const problem = await screen.findByTestId('module-problem');
    // The blocker by NAME, not by key: «المشتريات», not "purchasing".
    expect(problem).toHaveTextContent('المشتريات');
    expect(problem).toHaveTextContent('المخزون');
  });

  it('says plainly when the server refuses on role', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    vi.spyOn(apiClient, 'put').mockRejectedValue({
      isAxiosError: true,
      response: { status: 403, data: {} },
    });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    await user.click(within(row).getByRole('switch'));

    expect(await screen.findByTestId('module-problem')).toHaveTextContent(/المالك/);
  });
});

describe('what it shows', () => {
  it('names what a module depends on, so the order is not a surprise', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    expect(within(row).getByText(/تحتاج:/)).toHaveTextContent('المخزون');
  });

  it('says so when the list cannot be loaded', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network'));
    render(<ModulesPanel />);

    expect(await screen.findByText(/تعذّر تحميل قائمة الوحدات/)).toBeInTheDocument();
  });
});
