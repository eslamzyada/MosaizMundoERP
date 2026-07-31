import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';
import { apiClient } from '../api/client';
import type { Capability } from '../session/SessionProvider';
import * as sessionModule from '../session/SessionProvider';

/**
 * The search box, driven the way it is actually driven.
 *
 * Almost none of this is visible in a screenshot of it working. What is tested
 * here is what happens BETWEEN keystrokes: that a burst of typing is one
 * request and not six, that a slow answer to an old term cannot land on top of
 * a new one, that a kind the server invented after this bundle shipped is
 * skipped rather than fatal, and that Enter opens the row the eye is on.
 */

let role: Capability[] = ['administer', 'sell', 'manage_members', 'view_finance'];

function useFakeSession() {
  vi.spyOn(sessionModule, 'useSession').mockReturnValue({
    me: null,
    loading: false,
    error: false,
    reload: () => {},
    can: (capability: Capability) => role.includes(capability),
  });
}

/** Reports where the router ended up, so navigation is asserted, not assumed. */
function Here() {
  const { pathname, search } = useLocation();
  return <span data-testid="here">{pathname + search}</span>;
}

function renderPalette(onClose = () => {}) {
  return render(
    <MemoryRouter initialEntries={['/start']}>
      <CommandPalette open onClose={onClose} />
      <Routes>
        <Route path="*" element={<Here />} />
      </Routes>
    </MemoryRouter>,
  );
}

const hit = (kind: string, id: string, label: string, detail: string | null = null) => ({
  kind,
  id,
  label,
  detail,
});

/** Waits past the debounce, so "no request was made" means it never will be. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

beforeEach(() => {
  role = ['administer', 'sell', 'manage_members', 'view_finance'];
  useFakeSession();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('finding a page', () => {
  it('offers pages before the network has answered anything', async () => {
    // A promise that never settles: whatever appears, appears without it.
    vi.spyOn(apiClient, 'get').mockReturnValue(new Promise(() => {}) as never);
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'المخزون');

    expect(await screen.findByRole('option', { name: /المخزون/ })).toBeInTheDocument();
  });

  it('does not ask the server about a single character', async () => {
    // One letter matches half the restaurant, so the server answers with
    // nothing by design — asking is a round trip that was always going to come
    // back empty. Pages still filter, because that costs nothing.
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { results: [] } });
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'ط');

    expect(await screen.findByRole('option', { name: /الطلبات/ })).toBeInTheDocument();
    // Past the debounce before concluding nothing was sent. Asserting straight
    // away passes even with the guard removed — the request simply had not been
    // made YET.
    await settle();
    expect(get).not.toHaveBeenCalled();
  });

  it('says why there is nothing, rather than showing a blank panel', async () => {
    // An empty box with no explanation is indistinguishable from a broken one.
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { results: [] } });
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'x');

    expect(await screen.findByText(/حرفين على الأقل/)).toBeInTheDocument();
  });

  it('hides a page the signed-in role cannot open', async () => {
    role = ['sell'];
    useFakeSession();
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { results: [] } });
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'الأرباح');

    await waitFor(() => expect(screen.getByText(/لا توجد نتائج/)).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /الأرباح/ })).not.toBeInTheDocument();
  });
});

describe('finding a record', () => {
  it('shows what the server found, with the kind on a chip', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: { results: [hit('ingredient', 'ing-1', 'طماطم', 'kg')] },
    });
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'طماطم');

    const option = await screen.findByRole('option', { name: /طماطم/ });
    expect(option).toHaveTextContent('مكوّن');
    expect(option).toHaveTextContent('kg');
  });

  it('SKIPS a kind invented after this bundle shipped', async () => {
    // The API deploys separately. One unroutable row must cost one row, not
    // the screen.
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: {
        results: [
          hit('quantum_ledger', 'q-1', 'من المستقبل'),
          hit('supplier', 'sup-1', 'مورّد الشام'),
        ],
      },
    });
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'مورّد');

    expect(await screen.findByRole('option', { name: /مورّد الشام/ })).toBeInTheDocument();
    expect(screen.queryByText('من المستقبل')).not.toBeInTheDocument();
  });

  it('asks ONCE for a burst of typing', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { results: [] } });
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'طماطم');

    // Six characters, one request. Without the debounce this is five wasted
    // round trips per word on a connection that is already the slow part.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0][1]).toMatchObject({ params: { q: 'طماطم' } });
  });

  it('a slow answer to an OLD term cannot replace a new one', async () => {
    // The failure this prevents: type "طم", the request is slow; type "طماطم",
    // that request is fast and renders; then the first lands and the list
    // silently becomes results for a question no longer on the screen.
    let resolveSlow: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      resolveSlow = resolve;
    });

    const get = vi.spyOn(apiClient, 'get').mockImplementation((_url, config) => {
      const params = (config as { params?: { q?: string } } | undefined)?.params;
      if (params?.q === 'طم') return slow as never;
      return Promise.resolve({ data: { results: [hit('ingredient', 'new', 'طماطم كرزية')] } }) as never;
    });

    const user = userEvent.setup();
    renderPalette();
    const box = screen.getByRole('combobox');

    await user.type(box, 'طم');
    await waitFor(() => expect(get).toHaveBeenCalled());
    await user.type(box, 'اطم');

    expect(await screen.findByRole('option', { name: /طماطم كرزية/ })).toBeInTheDocument();

    // The stale answer finally arrives.
    resolveSlow({ data: { results: [hit('ingredient', 'stale', 'طماطم قديمة')] } });

    await waitFor(() => {
      expect(screen.queryByText('طماطم قديمة')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: /طماطم كرزية/ })).toBeInTheDocument();
  });

  it('explains a failure instead of showing an empty list', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('Network Error'));
    const user = userEvent.setup();

    renderPalette();
    await user.type(screen.getByRole('combobox'), 'طماطم');

    await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('جارٍ البحث'));
    expect(screen.queryByText(/لا توجد نتائج/)).not.toBeInTheDocument();
  });
});

describe('the keyboard', () => {
  async function openWithResults() {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: {
        results: [
          hit('ingredient', 'ing-1', 'طماطم'),
          hit('supplier', 'sup-1', 'مورّد الشام'),
        ],
      },
    });
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(onClose);
    await user.type(screen.getByRole('combobox'), 'طماطم');
    await screen.findByRole('option', { name: /مورّد الشام/ });
    return { user, onClose };
  }

  it('opens the highlighted row on Enter, landing ON the record', async () => {
    const { user, onClose } = await openWithResults();

    await user.keyboard('{Enter}');

    // ?focus= is what makes the destination page scroll to the row rather than
    // just being the page it happens to be on.
    expect(screen.getByTestId('here')).toHaveTextContent('/inventory?focus=ing-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('moves the highlight with the arrows', async () => {
    const { user } = await openWithResults();

    await user.keyboard('{ArrowDown}{Enter}');

    expect(screen.getByTestId('here')).toHaveTextContent('/suppliers?focus=sup-1');
  });

  it('wraps around rather than stopping at the end', async () => {
    const { user } = await openWithResults();

    // Up from the first lands on the last — a list that silently ignores a
    // key reads as frozen.
    await user.keyboard('{ArrowUp}{Enter}');

    expect(screen.getByTestId('here')).toHaveTextContent('/suppliers?focus=sup-1');
  });

  it('closes on Escape without navigating', async () => {
    const { user, onClose } = await openWithResults();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('here')).toHaveTextContent('/start');
  });

  it('Enter on an empty list does nothing at all', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { results: [] } });
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(onClose);

    await user.type(screen.getByRole('combobox'), 'لا شيء مطابق أبدًا');
    await waitFor(() => expect(screen.getByText(/لا توجد نتائج/)).toBeInTheDocument());
    await user.keyboard('{Enter}');

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('here')).toHaveTextContent('/start');
  });

  it('keeps the highlight inside a list that shrinks as you type', async () => {
    // Type, arrow down to the second row, then narrow the search so only one
    // row is left. If the highlight stayed at index 1, Enter would do nothing
    // and the box would look broken.
    const get = vi.spyOn(apiClient, 'get');
    get.mockResolvedValue({
      data: {
        results: [hit('ingredient', 'ing-1', 'طماطم'), hit('supplier', 'sup-1', 'مورّد')],
      },
    });
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox'), 'طم');
    await screen.findByRole('option', { name: /مورّد/ });
    await user.keyboard('{ArrowDown}');

    get.mockResolvedValue({ data: { results: [hit('ingredient', 'ing-1', 'طماطم')] } });
    await user.type(screen.getByRole('combobox'), 'اطم');
    await waitFor(() => expect(screen.queryByText('مورّد')).not.toBeInTheDocument());

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('here')).toHaveTextContent('/inventory?focus=ing-1');
  });
});

describe('what the screen reader is told', () => {
  it('marks the highlighted row as the active option', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: { results: [hit('ingredient', 'ing-1', 'طماطم')] },
    });
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox'), 'طماطم');
    const option = await screen.findByRole('option', { name: /طماطم/ });

    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', option.id);
  });

  it('is a modal dialog with a name', () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { results: [] } });
    renderPalette();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
  });

  it('renders nothing at all when closed', () => {
    render(
      <MemoryRouter>
        <CommandPalette open={false} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
