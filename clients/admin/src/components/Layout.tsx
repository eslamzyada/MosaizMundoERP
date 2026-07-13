import { NavLink, Outlet } from 'react-router-dom';
import { supabase } from '../lib/supabase';

const navItems = [
  { to: '/', label: 'لوحة التحكم', end: true },
  { to: '/orders', label: 'الطلبات', end: false },
  { to: '/inventory', label: 'المخزون', end: false },
  { to: '/recipes', label: 'الوصفات', end: false },
];

export default function Layout() {
  // Signing out clears the session; App's onAuthStateChange listener then
  // swaps the whole app back to the Login screen.
  async function handleLogout() {
    await supabase.auth.signOut();
  }

  return (
    <div className="flex h-full min-h-screen bg-surface-sand text-surface-dark">
      {/* Sidebar — deep twilight/charcoal chrome (contrasts the sand content). */}
      <aside className="flex w-64 flex-shrink-0 flex-col border-e border-surface-dark-border bg-surface-dark text-slate-100">
        <div className="flex h-16 items-center gap-3 border-b border-surface-dark-border px-6">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-sunset-500 to-twilight-600 text-base font-bold text-white">
            M
          </span>
          <span className="font-numerals text-base font-semibold tracking-tight text-white">
            Mosaiz&nbsp;Mundo
          </span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-5">
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
            الإدارة الخلفية
          </p>
          {navItems.map((item) => (
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

        <div className="border-t border-surface-dark-border p-3">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white"
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
        <Outlet />
      </main>
    </div>
  );
}
