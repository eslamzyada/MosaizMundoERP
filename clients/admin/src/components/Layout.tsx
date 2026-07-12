import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'لوحة التحكم', end: true },
  { to: '/orders', label: 'الطلبات', end: false },
  { to: '/inventory', label: 'المخزون', end: false },
  { to: '/recipes', label: 'الوصفات', end: false },
];

export default function Layout() {
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

        <div className="border-t border-surface-dark-border px-6 py-4 text-xs text-slate-500">
          وحدة تحكم الإدارة ·{' '}
          <span className="font-numerals">v0.1</span>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
