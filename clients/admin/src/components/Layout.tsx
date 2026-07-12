import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/orders', label: 'Orders', end: false },
  { to: '/inventory', label: 'Inventory', end: false },
];

export default function Layout() {
  return (
    <div className="flex h-full min-h-screen bg-slate-50 text-slate-900">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-100">
        <div className="flex h-16 items-center gap-2 border-b border-slate-800 px-6">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-500 text-sm font-bold">
            M
          </span>
          <span className="text-base font-semibold tracking-tight">Mosaiz Mundo</span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [
                  'block rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-300 hover:bg-slate-800/60 hover:text-white',
                ].join(' ')
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-800 px-6 py-4 text-xs text-slate-500">
          Admin Console · v0.1
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
