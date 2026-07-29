import { describe, expect, it } from 'vitest';
import { ORDER_STATUS_META, orderStatusMeta } from './orderStatus';

/**
 * The status lookup that blanked the admin.
 *
 * Migration 0029 added 'open'; this map was not updated; the first real open
 * tab made the lookup return undefined and took every page down with it. The
 * type system could not help — API responses are cast, not validated — so the
 * only thing that catches this is a test that names the statuses the SERVER
 * can actually produce.
 */
describe('orderStatusMeta', () => {
  it('covers every status the database can store', () => {
    // Kept as a literal list on purpose. It mirrors the CHECK constraint on
    // orders.status (0029), so adding a status there and not here fails HERE
    // rather than on somebody's screen.
    for (const status of ['open', 'completed', 'voided'] as const) {
      expect(ORDER_STATUS_META[status]).toBeDefined();
      expect(orderStatusMeta(status).label.length).toBeGreaterThan(0);
    }
  });

  it('labels an open tab without making it look like a problem', () => {
    const meta = orderStatusMeta('open');
    expect(meta.label).toBe('مفتوح');
    // An open tab is the normal middle of service. A warning colour would have
    // every table mid-meal looking like something to deal with.
    expect(meta.variant).not.toBe('destructive');
    expect(meta.variant).not.toBe('warning');
  });

  it('degrades an unknown status instead of returning undefined', () => {
    // This is the whole fix. The next status somebody adds in a migration and
    // forgets here should be mildly ugly, not fatal.
    const meta = orderStatusMeta('refunded');
    expect(meta).toBeDefined();
    expect(meta.label).toBe('refunded');
    expect(meta.variant).toBe('neutral');
  });

  it('never returns undefined, for any string at all', () => {
    for (const junk of ['', 'OPEN', 'مفتوح', 'null', 'undefined', '123']) {
      const meta = orderStatusMeta(junk);
      expect(meta).toBeTruthy();
      expect(typeof meta.label).toBe('string');
      expect(typeof meta.variant).toBe('string');
    }
  });
});
