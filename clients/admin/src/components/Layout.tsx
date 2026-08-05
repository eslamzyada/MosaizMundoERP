import { useEffect, useState } from 'react';
import ErrorBoundary from './ErrorBoundary';
import CommandPalette from './CommandPalette';
import NotificationBell from './NotificationBell';
import ClockWidget from './ClockWidget';
import { NavLink, Outlet } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { ROLE_LABELS, useSession } from '../session/SessionProvider';
import { DESTINATIONS } from '../lib/searchTargets';
import { navFor } from '../lib/roleHome';

export default function Layout() {
  const { me } = useSession();
  /**
   * Built PER ROLE, not filtered by capability.
   *
   * Filtering only makes the list shorter — it does not make it theirs. A
   * waiter was meeting thirteen destinations, eleven of which were somebody
   * else's job, with the one that mattered buried among them. `navFor` names
   * what each role should be OFFERED, which is a different question from what
   * they are permitted to open.
   *
   * Ordered by the role's list rather than by the shared DESTINATIONS order, so
   * each role's first item is its own home.
   */
  const allowed = navFor(me?.role, me?.modules);
  const visibleNav = allowed
    .map((route) => DESTINATIONS.find((d) => d.to === route))
    .filter((d): d is (typeof DESTINATIONS)[number] => d !== undefined);

  const [paletteOpen, setPaletteOpen] = useState(false);

  // Ctrl+K anywhere, including from inside a form field — that is the point of
  // it. preventDefault because the browser claims the same chord for its own
  // search bar.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Signing out clears the session; App's onAuthStateChange listener then
  // swaps the whole app back to the Login screen.
  async function handleLogout() {
    await supabase.auth.signOut();
  }

  return (
    /* h-screen, not h-full + min-h-screen: the two together let the layout grow
       past the viewport, and the sidebar is the one thing that must not. */
    <div className="flex h-screen bg-app-bg text-app-ink">
      {/* Sidebar — deep twilight/charcoal chrome, and deliberately the SAME in
          both themes: it is the app's anchor, and a light theme without it
          loses the contrast the whole layout is built on. Everything inside
          keeps the literal palette rather than the app-* tokens.

          NOT overflow-hidden: the notification panel is anchored in the header
          and has to escape this box. The scrolling belongs to the nav alone. */}
      <aside className="flex h-full w-64 flex-shrink-0 flex-col border-e border-surface-dark-border bg-surface-dark text-slate-100">
        <div className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-surface-dark-border ps-6 pe-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-sunset-500 to-twilight-600 text-base font-bold text-white">
            M
          </span>
          <span className="font-numerals flex-1 text-base font-semibold tracking-tight text-white">
            Mosaiz&nbsp;Mundo
          </span>
          {/* In the chrome, not on a page: what you are told does not depend on
              which screen you happen to be looking at. */}
          <NotificationBell />
        </div>

        {/* Dressed as a field rather than an icon, because a magnifying glass
            alone does not tell anyone the keyboard shortcut exists — and the
            shortcut is what makes this worth having. */}
        <div className="flex-shrink-0 px-3 pt-4">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-surface-dark-border bg-white/5 px-3 py-2 text-sm text-slate-400 transition-colors hover:border-twilight-500 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <span className="flex-1 text-start">بحث…</span>
            <kbd className="font-numerals rounded border border-surface-dark-border px-1.5 py-0.5 text-[10px] text-slate-500">
              Ctrl K
            </kbd>
          </button>
        </div>

        {/* min-h-0 is the whole fix: a flex child's default min-height is auto,
            so without it this list refuses to shrink below its own content and
            shoves everything after it out of the sidebar entirely. Thirteen
            destinations at a larger text scale is not an edge case. */}
        <nav
          className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-5"
          aria-label="التنقّل الرئيسي"
        >
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
            الإدارة الخلفية
          </p>
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  'block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-twilight-600 text-white shadow-sm'
                    : 'text-slate-300 hover:bg-white/5 hover:text-white',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Starting and ending a shift (0038). Renders nothing when the
            restaurant does not run labour. */}
        <ClockWidget />

        {/* Who you are and the way out. Pinned: these are the two things you
            reach for when a screen has gone wrong, and hunting for them at the
            bottom of a scroll is exactly the wrong moment to have to. */}
        <div className="flex-shrink-0 border-t border-surface-dark-border p-3">
          {/* Who am I signed in as, and with what authority — otherwise a
              missing button just looks like a bug. */}
          {me && (
            <div className="mb-2 rounded-lg bg-white/5 px-3 py-2">
              <p className="truncate text-xs font-medium text-slate-300" title={me.user_id}>
                {ROLE_LABELS[me.role]}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">دورك الحالي</p>
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
            تسجيل الخروج
          </button>
          <p className="px-3 pt-3 text-xs text-slate-500">
            وحدة تحكم الإدارة · <span className="font-numerals">v0.1</span>
          </p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {/* Wrapped INSIDE the layout, not around it: a page that throws
            leaves the sidebar and navigation intact, so you can walk away from
            the broken screen instead of staring at a black one. */}
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>

      {/* Outside <main> so it is not clipped by the page's own scrolling, and
          outside the ErrorBoundary so a page that throws still leaves you a
          way to navigate away from it. */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
