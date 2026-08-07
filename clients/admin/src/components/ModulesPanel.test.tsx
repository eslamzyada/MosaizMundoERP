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
    me: { user_id: 'u1', organization_id: 'o1', role, modules: ['inventory', 'purchasing'], plan: 'basic' },
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

    // Switching OFF asks first, so nothing has been sent yet.
    expect(put).not.toHaveBeenCalled();
    await user.click(within(screen.getByTestId('module-confirm')).getByText('إيقاف الوحدة'));

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
    await user.click(within(screen.getByTestId('module-confirm')).getByText('إيقاف الوحدة'));

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
    await user.click(within(screen.getByTestId('module-confirm')).getByText('إيقاف الوحدة'));

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
    await user.click(within(screen.getByTestId('module-confirm')).getByText('إيقاف الوحدة'));

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

describe('switching one OFF is asked about first', () => {
  it('does not send anything until the warning is accepted', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    await user.click(within(row).getByRole('switch'));

    const dialog = screen.getByTestId('module-confirm');
    expect(dialog).toHaveTextContent('المشتريات');
    // The promise that makes it safe to say yes.
    expect(dialog).toHaveTextContent(/لن يتغيّر شيء في التقارير/);
    expect(put).not.toHaveBeenCalled();
  });

  it('cancelling sends nothing and leaves the module on', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: modules });
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    await user.click(within(row).getByRole('switch'));
    await user.click(within(screen.getByTestId('module-confirm')).getByText('إلغاء'));

    expect(put).not.toHaveBeenCalled();
    expect(screen.queryByTestId('module-confirm')).not.toBeInTheDocument();
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('switching one ON is NOT asked about — the two are not symmetrical', async () => {
    // Turning something on adds a screen somebody can ignore. Turning it off
    // takes a section away from everyone at once.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [{ ...modules[1], enabled: false }],
    });
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    await user.click(within(row).getByRole('switch'));

    expect(screen.queryByTestId('module-confirm')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/modules/purchasing', { enabled: true }),
    );
  });
});

/**
 * The plan layer (0044).
 *
 * There are now three reasons a switch will not move, and this screen is the
 * only place a tenant ever sees them:
 *
 *   the plan does not reach it   → costs money
 *   you are not senior enough    → costs a conversation
 *   something depends on it      → costs a different click
 *
 * The first one is new and the most easily mistaken for the second. An owner
 * told "ask an owner" has nowhere to go.
 */

/** A locked capability: above the plan, and no promise keeping it open. */
const locked = {
  key: 'insights',
  name: 'المؤشرات',
  description: 'لوحة المؤشرات',
  depends_on: [],
  enforced_in: 'application',
  enabled: false,
  min_plan: 'premium',
  entitled: false,
  grandfathered: false,
};

const included = { ...modules[0], min_plan: 'basic', entitled: true, grandfathered: false };

describe('what the plan does and does not reach', () => {
  it('names the tier that would unlock a capability, rather than hiding it', async () => {
    // You cannot want what you cannot see. The row stays, with a price on it.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [included, locked] });
    render(<ModulesPanel />);

    expect(await screen.findByTestId('locked-insights')).toHaveTextContent('المتقدّمة');
    expect(screen.getByTestId('module-insights')).toBeInTheDocument();
  });

  it('holds the switch down, so nobody presses it into a 402', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [included, locked] });
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-insights');
    const sw = within(row).getByRole('switch');
    expect(sw).toBeDisabled();

    await user.click(sw);
    expect(put).not.toHaveBeenCalled();
  });

  it('leaves the switches the plan DOES reach alone', async () => {
    // Otherwise "everything is disabled" would pass the test above too.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [included, locked] });
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-inventory');
    expect(within(row).getByRole('switch')).not.toBeDisabled();
    expect(screen.queryByTestId('locked-inventory')).not.toBeInTheDocument();
  });

  it('a capability kept from a previous subscription says so, and still works', async () => {
    // Above the plan, running anyway. Without the label a reader concludes the
    // lock is broken; without the working switch they cannot turn it off.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [{ ...locked, key: 'exports', name: 'التصدير', enabled: true, grandfathered: true }],
    });
    render(<ModulesPanel />);

    expect(await screen.findByTestId('kept-exports')).toBeInTheDocument();
    expect(screen.queryByTestId('locked-exports')).not.toBeInTheDocument();

    const row = screen.getByTestId('module-exports');
    expect(within(row).getByRole('switch')).not.toBeDisabled();
  });

  it('lets a kept capability be switched back ON after being switched off', async () => {
    // The case the test above cannot reach, because it has the module already
    // running — so a lock that ignored `grandfathered` entirely would still
    // pass it. Here the promise is switched OFF and above the plan, which is
    // exactly the shape the lock refuses for everybody else.
    //
    // Getting this wrong is a one-way door: a tenant turns off something they
    // were promised, and can never turn it back on.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [{ ...locked, key: 'exports', name: 'التصدير', enabled: false, grandfathered: true }],
    });
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-exports');
    const sw = within(row).getByRole('switch');
    expect(sw).not.toBeDisabled();

    await user.click(sw);
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/modules/exports', { enabled: true }),
    );
  });

  it('never locks the way OUT — something above the plan can still be switched off', async () => {
    // A tenant stuck with a screen they cannot use AND cannot clear is the
    // worst of both. Only the way ON is a ceiling.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [{ ...locked, enabled: true }],
    });
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-insights');
    expect(within(row).getByRole('switch')).not.toBeDisabled();
  });

  it('shows the restaurant which plan it is on', async () => {
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [included] });
    render(<ModulesPanel />);

    expect(await screen.findByTestId('current-plan')).toHaveTextContent('الأساسية');
  });

  it('does not freeze the screen when the API says nothing about entitlement', async () => {
    // An older API omits these fields. This screen is not the gate — the
    // database is — so no opinion must mean "leave it alone", or a version
    // skew turns every switch off.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [{ ...modules[1], enabled: false }],
    });
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-purchasing');
    expect(within(row).getByRole('switch')).not.toBeDisabled();
  });
});

describe('when a downgrade lands between the screen and the click', () => {
  it('says which plan is needed, not "ask your owner"', async () => {
    // The race the disabled switch cannot close. An owner reading a 403 here
    // has nobody more senior to go to.
    stubSession('owner');
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [{ ...included, enabled: false }] });
    vi.spyOn(apiClient, 'put').mockRejectedValue(
      Object.assign(new Error('nope'), {
        isAxiosError: true,
        response: { status: 402, data: { code: 'plan_required', required_plan: 'enterprise' } },
      }),
    );
    const user = userEvent.setup();
    render(<ModulesPanel />);

    const row = await screen.findByTestId('module-inventory');
    await user.click(within(row).getByRole('switch'));

    const problem = await screen.findByTestId('module-problem');
    expect(problem).toHaveTextContent('المؤسسات');
    expect(problem).not.toHaveTextContent('المالك أو المدير الإقليمي');
  });
});
