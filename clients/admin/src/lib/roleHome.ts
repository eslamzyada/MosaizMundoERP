import type { Role } from '../types';

/**
 * What each role sees, and where each role starts.
 *
 * The old model was one back office with pages hidden from whoever could not
 * use them. That is a reasonable place to begin and a bad place to stay: a
 * waiter signing in met thirteen destinations, eleven of which were somebody
 * else's job, and the one screen that mattered to them was buried among the
 * rest. Hiding the ones they may not open only makes the list shorter — it does
 * not make it THEIRS.
 *
 * So navigation is built per role rather than filtered per role, and each role
 * lands somewhere that answers its own first question:
 *
 *   waiter   — which of my tables are open, and what is happening to them
 *   kitchen  — what has been fired that I have not cooked
 *   cashier  — nothing here. Their tool is the till, and a back office that
 *              pretends otherwise is a back office they will learn to ignore.
 *   accountant — the books
 *   management — everything, because their job genuinely is everything
 */

export const ROLE_HOME: Record<Role, string> = {
  // '/dashboard', not '/': `/` is the junction that redirects here, and naming
  // it as the destination would send the redirect chasing itself.
  owner: '/dashboard',
  regional_manager: '/dashboard',
  branch_manager: '/dashboard',
  accountant: '/reports',
  waiter: '/floor',
  kitchen: '/kitchen',
  // Deliberately not the dashboard: see `Till` for what this page says.
  cashier: '/till',
  staff: '/floor',
};

/**
 * Which destinations belong to which role.
 *
 * Named per role rather than derived from capabilities, because "may open" and
 * "should be offered" are different questions. A waiter MAY read the supplier
 * list — nothing stops them — but putting it in their sidebar tells them it is
 * part of their job, and it is not.
 */
export const ROLE_NAV: Record<Role, string[]> = {
  owner: [
    '/dashboard', '/menu', '/orders', '/inventory', '/stocktake', '/recipes',
    '/suppliers', '/purchase-orders', '/reports', '/insights',
    '/members', '/printers', '/settings',
  ],
  regional_manager: [
    '/dashboard', '/menu', '/orders', '/inventory', '/stocktake', '/recipes',
    '/suppliers', '/purchase-orders', '/reports', '/insights',
    '/members', '/printers', '/settings',
  ],
  branch_manager: [
    '/dashboard', '/menu', '/orders', '/inventory', '/stocktake', '/recipes',
    '/suppliers', '/purchase-orders', '/reports', '/insights',
    '/members', '/printers', '/settings',
  ],
  // Reads the books and nothing operational. The stock VALUE matters to them;
  // the stocktake that produces it does not.
  accountant: ['/reports', '/insights', '/orders', '/inventory', '/settings'],
  // The floor: my tables, what is on them, and what the kitchen is doing.
  waiter: ['/floor', '/orders', '/menu', '/settings'],
  // The pass: what has been fired, and what it is made of.
  kitchen: ['/kitchen', '/orders', '/menu', '/recipes', '/settings'],
  // One page, and it says to use the till.
  cashier: ['/till', '/settings'],
  staff: ['/floor', '/orders', '/menu', '/settings'],
};

/** The landing route for a role, falling back to the floor for an unknown one. */
export function homeFor(role: Role | null | undefined): string {
  if (!role) return '/dashboard';
  return ROLE_HOME[role] ?? '/dashboard';
}

/**
 * The destinations a role should be OFFERED, in the order given above.
 *
 * An unknown role — one added to the database before this bundle was rebuilt —
 * gets the safe minimum rather than nothing at all. A sidebar with no items
 * looks like a broken app; a sidebar with two looks like a limited account,
 * which is the truth.
 */
export function navFor(role: Role | null | undefined): string[] {
  if (!role) return ['/settings'];
  return ROLE_NAV[role] ?? ['/orders', '/menu', '/settings'];
}
