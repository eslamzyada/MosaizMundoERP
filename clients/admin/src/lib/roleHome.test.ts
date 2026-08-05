import { describe, expect, it } from 'vitest';
import { DESTINATIONS } from './searchTargets';
import { ROLE_HOME, ROLE_NAV, homeFor, navFor } from './roleHome';
import { ROLES } from '../types';

/**
 * Whose screen is whose.
 *
 * The thing being prevented here is the old behaviour, which was not a bug and
 * was still wrong: one back office for everybody, with the pages a role could
 * not use hidden from it. Hiding makes the list shorter. It does not make it
 * theirs, and a waiter meeting eleven destinations belonging to other people
 * learns that this software is not for them.
 */

describe('every role is accounted for', () => {
  it('has a home and a navigation list — no role falls through', () => {
    // A role added to the union and forgotten here would land on whatever the
    // fallback is, silently, and look like a permissions bug forever.
    for (const role of ROLES) {
      expect({ role, home: typeof ROLE_HOME[role] }).toEqual({ role, home: 'string' });
      expect({ role, nav: Array.isArray(ROLE_NAV[role]) }).toEqual({ role, nav: true });
    }
  });

  it('never offers a destination that does not exist', () => {
    // A typo here produces a sidebar item that renders and goes nowhere.
    const known = new Set(DESTINATIONS.map((d) => d.to));
    for (const role of ROLES) {
      const unknown = ROLE_NAV[role].filter((route) => !known.has(route));
      expect({ role, unknown }).toEqual({ role, unknown: [] });
    }
  });

  it('starts every role on a page its own navigation offers', () => {
    // Landing somewhere the sidebar does not list leaves the highlight on
    // nothing, and the reader with no way back to where they started.
    for (const role of ROLES) {
      const home = ROLE_HOME[role];
      expect({ role, offersHome: ROLE_NAV[role].includes(home) }).toEqual({
        role,
        offersHome: true,
      });
    }
  });
});

describe('the floor is not the back office', () => {
  it('sends a waiter to the floor and a kitchen to the pass', () => {
    expect(homeFor('waiter')).toBe('/floor');
    expect(homeFor('kitchen')).toBe('/kitchen');
  });

  it('gives a CASHIER one page, because their tool is the till', () => {
    // The whole point of the cashier's screen is that there is almost nothing
    // on it. A dashboard here is a second place to look for answers that are
    // not there.
    expect(homeFor('cashier')).toBe('/till');
    expect(navFor('cashier')).toEqual(['/till', '/settings']);
  });

  it('keeps the money away from the floor', () => {
    for (const role of ['waiter', 'kitchen', 'cashier'] as const) {
      expect(navFor(role)).not.toContain('/reports');
      expect(navFor(role)).not.toContain('/insights');
      expect(navFor(role)).not.toContain('/members');
    }
  });

  it('keeps buying and stock away from the floor too', () => {
    for (const role of ['waiter', 'kitchen', 'cashier'] as const) {
      expect(navFor(role)).not.toContain('/purchase-orders');
      expect(navFor(role)).not.toContain('/suppliers');
      expect(navFor(role)).not.toContain('/stocktake');
    }
  });

  it('gives the kitchen the recipes it cooks from, and the waiter none', () => {
    // The difference between the two floor roles, in one line: one of them
    // needs to know what is in the dish.
    expect(navFor('kitchen')).toContain('/recipes');
    expect(navFor('waiter')).not.toContain('/recipes');
  });

  it('leaves management with everything', () => {
    for (const role of ['owner', 'regional_manager', 'branch_manager'] as const) {
      expect(navFor(role)).toContain('/reports');
      expect(navFor(role)).toContain('/members');
      expect(navFor(role)).toContain('/purchase-orders');
      expect(navFor(role)).toContain('/dashboard');
    }
  });

  it('sends an accountant to the books rather than to a dashboard', () => {
    expect(homeFor('accountant')).toBe('/reports');
    expect(navFor('accountant')).not.toContain('/stocktake');
  });
});

describe('a role this build has never heard of', () => {
  it('gets a working minimum, not an empty sidebar', () => {
    // The API and this bundle ship separately, so a role added to the database
    // first WILL arrive here unknown. An empty sidebar looks like a broken app;
    // a short one looks like a limited account, which is the truth.
    const unknown = 'sommelier' as never;
    expect(navFor(unknown).length).toBeGreaterThan(0);
    expect(homeFor(unknown)).toBe('/dashboard');
  });

  it('and so does a session with no membership at all', () => {
    expect(navFor(null)).toEqual(['/settings']);
    expect(homeFor(null)).toBe('/dashboard');
  });
});

describe('the sidebar is role ∩ modules (0037)', () => {
  it('drops a destination whose module the restaurant does not run', () => {
    // The owner is OFFERED purchase orders; a café that does not run
    // purchasing should not meet them at all.
    const withPurchasing = navFor('owner', ['inventory', 'purchasing', 'insights']);
    expect(withPurchasing).toContain('/purchase-orders');

    const without = navFor('owner', ['inventory', 'insights']);
    expect(without).not.toContain('/purchase-orders');
    expect(without).not.toContain('/suppliers');
  });

  it('never drops a destination that belongs to no module', () => {
    // Settings above all: a restaurant that could switch off its own settings
    // screen would have no way back.
    const nothing = navFor('owner', []);
    expect(nothing).toContain('/settings');
    expect(nothing).toContain('/dashboard');
    expect(nothing).toContain('/orders');
    expect(nothing).toContain('/menu');
  });

  it('treats an unknown module list as "everything", not as "nothing"', () => {
    // undefined means the answer has not arrived (older API, or first paint).
    // Hiding navigation on missing information would look like a broken app.
    expect(navFor('owner', undefined)).toEqual(navFor('owner'));
    expect(navFor('owner', undefined)).toContain('/inventory');
  });

  it('an EMPTY list is an answer, and it is different from no answer', () => {
    expect(navFor('owner', []).length).toBeLessThan(navFor('owner', undefined).length);
  });

  it('still respects the role: modules cannot widen what a waiter is offered', () => {
    const waiter = navFor('waiter', ['inventory', 'purchasing', 'insights', 'printers']);
    expect(waiter).not.toContain('/inventory');
    expect(waiter).not.toContain('/purchase-orders');
    expect(waiter).toContain('/floor');
  });
});

describe('the capabilities added in 0038 and 0039', () => {
  it('hides الورديات and الحجوزات from a tenant that runs neither', () => {
    // Both ship switched off, so this is the state a new restaurant is in.
    const none = navFor('owner', ['inventory', 'purchasing']);
    expect(none).not.toContain('/schedule');
    expect(none).not.toContain('/reservations');
  });

  it('offers each one only when its own module is on', () => {
    const labourOnly = navFor('owner', ['labour']);
    expect(labourOnly).toContain('/schedule');
    expect(labourOnly).not.toContain('/reservations');

    const bookingsOnly = navFor('owner', ['reservations']);
    expect(bookingsOnly).toContain('/reservations');
    expect(bookingsOnly).not.toContain('/schedule');
  });

  it('gives a waiter both, because both are floor work', () => {
    // The rota is theirs to read and the phone is theirs to answer. Neither is
    // a management screen, and putting them behind one would mean the shift
    // board lives in an office nobody on the floor can open.
    const waiter = navFor('waiter', ['labour', 'reservations']);
    expect(waiter).toContain('/schedule');
    expect(waiter).toContain('/reservations');
  });

  it('does not give the kitchen bookings — they do not seat anybody', () => {
    const kitchen = navFor('kitchen', ['labour', 'reservations']);
    expect(kitchen).toContain('/schedule');
    expect(kitchen).not.toContain('/reservations');
  });
});
