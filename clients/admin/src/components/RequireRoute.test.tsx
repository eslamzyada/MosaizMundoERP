import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import RequireRoute from './RequireRoute';

/**
 * The hole a waiter found: every route was mounted for everybody.
 *
 * Only the sidebar differed, so /reports, /members and /insights were one typed
 * URL — or one search result — away from anybody signed in. The search box made
 * it trivial rather than theoretical, because it returned records from exactly
 * those pages.
 *
 * These assert the GUARD, not the sidebar. A test that only checked the
 * navigation would keep passing while every page stayed reachable, which is
 * precisely the state this replaces.
 */

const mockSession = vi.hoisted(() => ({ me: null as { role: string; modules?: string[] } | null }));

vi.mock('../session/SessionProvider', () => ({
  useSession: () => mockSession,
  ROLE_LABELS: {},
}));

function renderAt(path: string, role: string | null, modules: string[] = []) {
  mockSession.me = role ? { role, modules } : null;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RequireRoute />}>
          <Route path="/reports" element={<div>REPORTS</div>} />
          <Route path="/members" element={<div>MEMBERS</div>} />
          <Route path="/floor" element={<div>FLOOR</div>} />
          <Route path="/till" element={<div>TILL</div>} />
          <Route path="/orders" element={<div>ORDERS</div>} />
          <Route path="/orders/:id" element={<div>ONE ORDER</div>} />
          <Route path="/dashboard" element={<div>DASHBOARD</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('a role cannot open somebody else\'s page', () => {
  it('a waiter typing /reports lands on the floor instead', () => {
    renderAt('/reports', 'waiter');
    expect(screen.queryByText('REPORTS')).not.toBeInTheDocument();
    expect(screen.getByText('FLOOR')).toBeInTheDocument();
  });

  it('a waiter cannot reach the team page', () => {
    renderAt('/members', 'waiter');
    expect(screen.queryByText('MEMBERS')).not.toBeInTheDocument();
  });

  it('a cashier is returned to the till', () => {
    // A cashier has exactly one page, and the redirect says so by landing them
    // on it rather than on an error.
    renderAt('/dashboard', 'cashier');
    expect(screen.getByText('TILL')).toBeInTheDocument();
  });

  it('a manager opens the reports they are responsible for', () => {
    // The positive half. Without it, a guard that refused EVERYTHING would
    // satisfy every assertion above and break the product completely.
    renderAt('/reports', 'branch_manager');
    expect(screen.getByText('REPORTS')).toBeInTheDocument();
  });

  it('a waiter still gets their own pages', () => {
    renderAt('/floor', 'waiter');
    expect(screen.getByText('FLOOR')).toBeInTheDocument();
  });

  it('a record under an allowed section is allowed', () => {
    // /orders/<id> belongs to whoever may open /orders. Guarding only exact
    // paths would have made every record page unreachable — a subtler outage
    // than the one being fixed.
    renderAt('/orders/8f14e45f-ceea-467a-9f2a-1a2b3c4d5e6f', 'waiter');
    expect(screen.getByText('ONE ORDER')).toBeInTheDocument();
  });

  it('renders nothing at all while the session is still loading', () => {
    // Rendering the child would flash a page the role may not have; redirecting
    // would bounce somebody off a page they are entitled to.
    renderAt('/reports', null);
    expect(screen.queryByText('REPORTS')).not.toBeInTheDocument();
    expect(screen.queryByText('FLOOR')).not.toBeInTheDocument();
  });
});
