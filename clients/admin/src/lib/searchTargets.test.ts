import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  hitPath,
  kindLabel,
  matchDestinations,
  routableHits,
} from './searchTargets';
import type { SearchHit } from './searchTargets';
import type { Capability } from '../session/SessionProvider';

/**
 * Where the search box can send you.
 *
 * Two of these matter far more than they look. The first is that an unknown
 * kind returns null instead of throwing: the API ships separately from this
 * bundle, so a newer server WILL one day answer with a kind added after this
 * was built, and an unguarded lookup would take the whole palette down over one
 * row — the same failure shape as the order status that blanked the dashboard.
 * The second is the capability filter, because a search result is a link, and
 * offering a cashier a link to the profit page is offering them a 403.
 */

const everyone: (c: Capability) => boolean = () => true;
const cashier: (c: Capability) => boolean = (c) => c !== 'view_finance';

describe('the destinations', () => {
  it('covers every page the sidebar shows', () => {
    // The sidebar renders this same array. If a route is added to the router
    // and not to here, it is missing from BOTH — which is the point of there
    // being one list.
    const routes = DESTINATIONS.map((d) => d.to);
    for (const route of [
      '/',
      '/menu',
      '/orders',
      '/inventory',
      '/stocktake',
      '/suppliers',
      '/purchase-orders',
      '/printers',
      '/settings',
      '/recipes',
      '/reports',
      '/insights',
      '/members',
    ]) {
      expect(routes).toContain(route);
    }
  });

  it('finds a page by its name', () => {
    expect(matchDestinations('المخزون', everyone).map((d) => d.to)).toContain('/inventory');
  });

  it('finds a page by what it is FOR, not only what it is called', () => {
    // Nobody looking for the logo knows it lives under settings.
    expect(matchDestinations('الشعار', everyone).map((d) => d.to)).toEqual(['/settings']);
    expect(matchDestinations('الوضع الداكن', everyone).map((d) => d.to)).toEqual(['/settings']);
  });

  it('matches latin keywords case-insensitively', () => {
    expect(matchDestinations('SETTINGS', everyone).map((d) => d.to)).toContain('/settings');
  });

  it('never offers a cashier the page they would be refused', () => {
    const asCashier = matchDestinations('الأرباح', cashier);
    expect(asCashier).toHaveLength(0);
    // …and the page really is findable, so the emptiness above means the
    // filter fired rather than the keyword being wrong.
    expect(matchDestinations('الأرباح', everyone).map((d) => d.to)).toContain('/reports');
  });

  it('answers an empty term with nothing, not with everything', () => {
    expect(matchDestinations('', everyone)).toHaveLength(0);
    expect(matchDestinations('   ', everyone)).toHaveLength(0);
  });
});

describe('routing a record', () => {
  it('sends each kind to the page it lives on, carrying its id', () => {
    expect(hitPath({ kind: 'ingredient', id: 'abc' })).toBe('/inventory?focus=abc');
    expect(hitPath({ kind: 'menu_item', id: 'abc' })).toBe('/menu?focus=abc');
    expect(hitPath({ kind: 'supplier', id: 'abc' })).toBe('/suppliers?focus=abc');
    expect(hitPath({ kind: 'member', id: 'abc' })).toBe('/members?focus=abc');
    expect(hitPath({ kind: 'order', id: 'abc' })).toBe('/orders?focus=abc');
    expect(hitPath({ kind: 'purchase_order', id: 'abc' })).toBe('/purchase-orders?focus=abc');
    expect(hitPath({ kind: 'printer', id: 'abc' })).toBe('/printers?focus=abc');
  });

  it('escapes the id rather than pasting it into a query string', () => {
    expect(hitPath({ kind: 'order', id: 'a b&c=d' })).toBe('/orders?focus=a%20b%26c%3Dd');
  });

  it('RETURNS NULL for a kind this build has never heard of', () => {
    // A newer API is a certainty, not a hypothetical.
    expect(hitPath({ kind: 'stocktake_session', id: 'x' })).toBeNull();
    expect(kindLabel('stocktake_session')).toBeNull();
  });

  it('drops the unknown row and keeps the rest of the list working', () => {
    const hits = [
      { kind: 'ingredient', id: '1', label: 'طماطم', detail: 'kg' },
      { kind: 'time_machine', id: '2', label: 'من المستقبل', detail: null },
      { kind: 'supplier', id: '3', label: 'مورّد', detail: null },
    ] as unknown as SearchHit[];

    expect(routableHits(hits).map((h) => h.id)).toEqual(['1', '3']);
  });
});
