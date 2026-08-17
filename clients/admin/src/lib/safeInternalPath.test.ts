import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safeInternalPath';

/**
 * An open redirect is a phishing primitive, and the reason it works is that the
 * link genuinely started on the real admin. Somebody clicks a notification,
 * lands on a login page that looks right, and types their password into it.
 *
 * The payloads below are the point of this file. A rule written against `//`
 * — which is what the previous guard in NotificationBell tested — is a rule
 * written against one spelling of the attack, and `/\evil.com` walks straight
 * past it.
 */
describe('what must NOT be treated as an internal route', () => {
  const offSite = [
    ['protocol-relative', '//evil.com'],
    ['the backslash bypass this advisory is about', '/\\evil.com'],
    ['backslash, doubled', '/\\\\evil.com'],
    ['backslash after a slash', '//\\evil.com'],
    ['an absolute url', 'https://evil.com'],
    ['a scheme-less absolute url', 'evil.com'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path that leaves nothing to anchor on', '../../evil'],
    ['empty', ''],
  ] as const;

  it.each(offSite)('refuses %s', (_name, payload) => {
    expect(safeInternalPath(payload)).toBeNull();
  });

  it('refuses the forms a browser silently repairs', () => {
    // A browser strips tabs, newlines and leading control characters before
    // resolving a URL, so `/<TAB>/evil.com` is `//evil.com` by the time it
    // matters — while a startsWith('//') check sees something harmless.
    expect(safeInternalPath('/\t/evil.com')).toBeNull();
    expect(safeInternalPath('/\n/evil.com')).toBeNull();
    expect(safeInternalPath('\t//evil.com')).toBeNull();
    expect(safeInternalPath('/\t\\evil.com')).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    // The value arrives from JSON, where a column can be null and a field can
    // be missing or the wrong type entirely.
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath(42)).toBeNull();
    expect(safeInternalPath({ toString: () => '/menu' })).toBeNull();
  });
});

describe('what must still work', () => {
  /**
   * The counterfactual half. A guard that refuses everything passes every test
   * above and breaks the notification bell, which is a worse bug than the one
   * being fixed — nobody notices a link that quietly does nothing.
   */
  const internal = [
    '/menu',
    '/reservations',
    '/modules',
    '/reports',
    '/online-orders',
    '/inventory?focus=6b1f2c7e-0d3a-4a71-9f52-0f3f5b6a1c22',
    '/orders/6b1f2c7e-0d3a-4a71-9f52-0f3f5b6a1c22',
    '/settings#printers',
    '/',
  ];

  it.each(internal)('accepts %s', (path) => {
    expect(safeInternalPath(path)).toBe(path);
  });

  it('accepts every link the database actually writes', () => {
    // These are the five literals the SECURITY DEFINER triggers use. If this
    // guard ever refused one of them, the bell would stop navigating and the
    // only symptom would be a click that does nothing.
    for (const link of ['/menu', '/online-orders', '/reservations', '/modules', '/reports']) {
      expect(safeInternalPath(link)).toBe(link);
    }
  });

  it('returns the string the BROWSER will resolve, not the one it was given', () => {
    // Handing the router back the raw value would pass on the characters this
    // just reasoned about.
    expect(safeInternalPath('/men\tu')).toBe('/menu');
  });
});
