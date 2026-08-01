import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MenuChangeQueue from './MenuChangeQueue';
import { apiClient } from '../api/client';

/**
 * The approval queue.
 *
 * Two things here are worth pinning, and neither is visible in a screenshot of
 * a working screen:
 *
 *   1. A row shows a BEFORE and AFTER. "A price change was requested" makes
 *      somebody open a second screen to find out what they are agreeing to, and
 *      approving without knowing is the failure this whole cycle exists to stop.
 *   2. A field the proposal leaves alone must not render as a change. `null`
 *      means "leave it", not "clear it" — showing an arrow into an empty box
 *      would display a change nobody asked for.
 */

const change = (over: Record<string, unknown> = {}) => ({
  id: 'req-1',
  kind: 'update',
  status: 'pending',
  sellable_item_id: 'item-1',
  current: { name: 'فتّة لحم', sku: 'FATTA-1', price: 85 },
  proposed: { name: null, sku: null, price: 95 },
  reason: 'ارتفع سعر اللحم من المورّد',
  requested_by: 'kitchen-1',
  requested_at: '2026-08-01T10:00:00.000Z',
  decided_by: null,
  decided_at: null,
  decision_note: null,
  ...over,
});

const stub = (rows: unknown[]) =>
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: rows });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what a decider sees', () => {
  it('shows the before and the after, not a description of one', async () => {
    stub([change()]);
    render(<MenuChangeQueue canDecide currentUserId="owner-1" onApplied={() => {}} />);

    const row = await screen.findByTestId('change-req-1');
    expect(within(row).getByText('85.00')).toBeInTheDocument();
    expect(within(row).getByText('95.00')).toBeInTheDocument();
    expect(within(row).getByText(/ارتفع سعر اللحم/)).toBeInTheDocument();
  });

  it('does NOT show a change for a field the proposal left alone', async () => {
    // proposed.name is null — meaning "leave the name" — so rendering it would
    // put a change on screen that nobody proposed.
    stub([change()]);
    render(<MenuChangeQueue canDecide currentUserId="owner-1" onApplied={() => {}} />);

    const row = await screen.findByTestId('change-req-1');
    expect(within(row).queryByText(/الاسم:/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/الكود:/)).not.toBeInTheDocument();
  });

  it('approving applies it and refreshes the menu above', async () => {
    stub([change()]);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ data: {} });
    const onApplied = vi.fn();
    const user = userEvent.setup();

    render(<MenuChangeQueue canDecide currentUserId="owner-1" onApplied={onApplied} />);
    await user.click(await screen.findByRole('button', { name: 'اعتماد' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/menu-changes/req-1/decide', {
      approve: true,
      note: undefined,
    }));
    // The dish above has changed, so the table has to refetch.
    expect(onApplied).toHaveBeenCalled();
  });

  it('offers no decision on the decider\'s OWN request, and says why', async () => {
    // The fix is to ask a colleague, which a greyed-out button does not convey.
    stub([change({ requested_by: 'owner-1' })]);
    render(<MenuChangeQueue canDecide currentUserId="owner-1" onApplied={() => {}} />);

    await screen.findByTestId('change-req-1');
    expect(screen.queryByRole('button', { name: 'اعتماد' })).not.toBeInTheDocument();
    // Scoped to the ROW: the panel's own subtitle says something similar, and
    // matching that would pass with no per-row explanation at all.
    const own = screen.getByTestId('change-req-1');
    expect(within(own).getByText(/لا يعتمد أحد طلبه بنفسه/)).toBeInTheDocument();
    // …but they can still take it back.
    expect(screen.getByRole('button', { name: 'سحب الطلب' })).toBeInTheDocument();
  });
});

describe('what everybody else sees', () => {
  it('a waiter sees the queue and no buttons', async () => {
    // Reading is open on purpose: the price they are quoting is about to move.
    stub([change()]);
    render(<MenuChangeQueue canDecide={false} currentUserId="waiter-1" onApplied={() => {}} />);

    await screen.findByTestId('change-req-1');
    expect(screen.getByText('95.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'اعتماد' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'رفض' })).not.toBeInTheDocument();
  });

  it('renders nothing at all when the queue is empty', async () => {
    // An empty panel headed "waiting for approval" is a permanent reminder of
    // nothing.
    stub([]);
    const { container } = render(
      <MenuChangeQueue canDecide currentUserId="owner-1" onApplied={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('passes the server\'s refusal through rather than inventing one', async () => {
    stub([change()]);
    vi.spyOn(apiClient, 'post').mockRejectedValue({
      response: {
        status: 403,
        data: { error: 'A menu change must be decided by somebody other than the person who proposed it' },
      },
    });
    const user = userEvent.setup();

    render(<MenuChangeQueue canDecide currentUserId="owner-1" onApplied={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'اعتماد' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/other than the person who proposed/);
  });
});

describe('retiring', () => {
  it('is described in words, because a diff of a removal is nonsense', async () => {
    stub([
      change({
        id: 'req-2',
        kind: 'retire',
        proposed: { name: null, sku: null, price: null },
        reason: 'توقّف المورّد',
      }),
    ]);
    render(<MenuChangeQueue canDecide currentUserId="owner-1" onApplied={() => {}} />);

    const row = await screen.findByTestId('change-req-2');
    // The kind chip and the sentence both say it; the sentence is the one that
    // explains what approving would do.
    expect(within(row).getAllByText(/إيقاف/).length).toBeGreaterThan(0);
    expect(within(row).getByText(/يبقى في السجلّات/)).toBeInTheDocument();
  });
});
