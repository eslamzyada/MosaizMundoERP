/**
 * Is this string a route INSIDE the admin, or somewhere else entirely?
 *
 * WHY THIS EXISTS, and why the obvious check is not enough.
 *
 * React Router 6.x carries two advisories, and the live one here is an open
 * redirect: a target beginning `//host` or `/\host` is not an internal path at
 * all. The browser normalises the backslash form to `//host` and leaves the
 * application — an "internal" navigation that lands on somebody else's site,
 * which is the first half of a convincing phishing flow because the link
 * genuinely started on the real admin.
 *
 * The fix in react-router is 7.18.0; 6.30.4 is the last 6.x and is vulnerable,
 * so the library-level fix is a major migration. This closes it at the
 * application boundary instead, which holds regardless of the router version.
 *
 * NotificationBell already had a guard:
 *
 *     item.link.startsWith('/') && !item.link.startsWith('//')
 *
 * That is the right instinct and it misses the exact bypass the advisory is
 * about: `/\evil.com` passes both tests. A rule written against one spelling
 * of an attack tends to be a rule written against the example, not the attack.
 *
 * ----------------------------------------------------------------------------
 * WHAT IS ACTUALLY REACHABLE TODAY.
 *
 * Nothing, and this is still worth having. Both non-literal navigation targets
 * are safe as things stand:
 *
 *   * the command palette builds `${route}?focus=${encodeURIComponent(id)}`
 *     from a fixed table of routes;
 *   * every notifications.link in the database is a hardcoded literal — '/menu',
 *     '/reservations', '/modules', '/reports', '/online-orders' — written by
 *     SECURITY DEFINER triggers. User input reaches the title and body, never
 *     the link, and the API exposes no way to create a notification at all.
 *
 * So the safety rests on an invariant nobody enforces: that no user input ever
 * reaches a navigate() target. One endpoint that writes a notification link,
 * one page that navigates to a value from a record, and it is false — with no
 * failing test to say so. Enforcing it costs a function.
 */

/**
 * Characters a browser IGNORES inside a URL, which an attacker uses to break
 * up a prefix that a naive check is looking for. `/\tevil.com` reads as
 * `/evil.com` to a string comparison and as something else to the browser.
 */
// eslint-disable-next-line no-control-regex
const IGNORED_BY_BROWSERS = /[\u0000-\u0020]/g;

/**
 * Returns the path when it is unambiguously internal, otherwise null.
 *
 * Deliberately a whitelist of shapes rather than a list of bad prefixes: the
 * result must begin with exactly one `/`, and contain no backslash anywhere —
 * an admin route never has one, so there is nothing to lose by refusing them
 * outright rather than reasoning about which positions are dangerous.
 */
export function safeInternalPath(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;

  const stripped = candidate.replace(IGNORED_BY_BROWSERS, '');

  if (!stripped.startsWith('/')) return null;
  // `//host` — protocol-relative, and off-site.
  if (stripped.startsWith('//')) return null;
  // `/\host` — the same thing after the browser normalises it, and the exact
  // bypass the react-router advisory describes.
  if (stripped.includes('\\')) return null;

  // Returns the STRIPPED value, not the original: navigating to the string the
  // browser will actually resolve is the whole point, and passing the raw one
  // through would hand the router back the characters this just reasoned about.
  return stripped;
}
