/**
 * Which kinds of record a role may find in the search box.
 *
 * WHY THIS EXISTS.
 *
 * `/api/search` had no role gate. Its own route file argued the point:
 *
 *     No role gate. Search is navigation, and RLS already decides what there
 *     is to navigate to... What keeps it honest is what the handler does NOT
 *     return: no totals, no costs, nothing the finance pages are gated for.
 *
 * The first half is wrong and the second half is too narrow. RLS decides which
 * TENANT's rows exist, not which of them a waiter should see — that is the
 * role's job, and nothing was doing it. And "no totals" is not the only thing
 * worth protecting: a waiter typing three letters could retrieve
 *
 *   * every colleague's email address AND their role,
 *   * supplier names, and the purchase orders placed with them,
 *   * printers by name and by host:port — addresses on the restaurant's LAN.
 *
 * None of those pages are in a waiter's sidebar. The search box was a way
 * around the only thing that had ever separated the roles.
 *
 * ----------------------------------------------------------------------------
 * DERIVED FROM THE PAGE, NOT INVENTED HERE.
 *
 * Each kind is tied to the destination that displays it, and a role may find a
 * kind exactly when it may open that page. One rule, so a new role cannot be
 * given a sidebar without also being given a search scope — and so the two can
 * never disagree about what "may open" means.
 *
 * This is computed on the SERVER from the caller's membership. A scope the
 * client sends is not a gate; it is a suggestion from the party being gated.
 */

export type SearchKind =
  | 'menu_item'
  | 'ingredient'
  | 'supplier'
  | 'member'
  | 'purchase_order'
  | 'order'
  | 'printer';

/** The page each kind lives on. */
const KIND_PAGE: Record<SearchKind, string> = {
  menu_item: '/menu',
  ingredient: '/inventory',
  supplier: '/suppliers',
  member: '/members',
  purchase_order: '/purchase-orders',
  order: '/orders',
  printer: '/printers',
};

/**
 * The pages each role may open.
 *
 * Mirrors ROLE_NAV in clients/admin/src/lib/roleHome.ts. It is duplicated
 * rather than imported because the client cannot be the authority on its own
 * permissions — but the two are asserted to agree by a test, so a change to one
 * that is not made to the other fails the build rather than opening a hole.
 */
const ROLE_PAGES: Record<string, string[]> = {
  owner: Object.values(KIND_PAGE),
  regional_manager: Object.values(KIND_PAGE),
  branch_manager: Object.values(KIND_PAGE),
  // The books, and the stock they are computed from. Not the people, not the
  // printers.
  accountant: ['/orders', '/inventory'],
  // The floor: the menu they sell from and the orders they took.
  waiter: ['/menu', '/orders'],
  // The pass: what was ordered, and what it is made of.
  kitchen: ['/menu', '/orders', '/inventory'],
  // One page, and it is the till. Nothing to search for here.
  cashier: [],
  staff: ['/menu', '/orders'],
};

/**
 * The kinds this role may find. Unknown roles get nothing.
 *
 * Failing closed matters more here than anywhere else in this file: a role
 * added to the database and forgotten here should find NOTHING, not everything.
 */
export function searchKindsFor(role: string | null | undefined): SearchKind[] {
  const pages = ROLE_PAGES[role ?? ''] ?? [];
  return (Object.keys(KIND_PAGE) as SearchKind[]).filter((kind) =>
    pages.includes(KIND_PAGE[kind]),
  );
}

/** Exposed for the test that keeps this in step with the client's ROLE_NAV. */
export const SEARCH_SCOPE_INTERNALS = { KIND_PAGE, ROLE_PAGES };
