import { useEffect, useState } from 'react';
import PreferencesProvider from './session/PreferencesProvider';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import Inventory from './pages/Inventory';
import Recipes from './pages/Recipes';
import Members from './pages/Members';
import Reports from './pages/Reports';
import Insights from './pages/Insights';
import Floor from './pages/Floor';
import Kitchen from './pages/Kitchen';
import Till from './pages/Till';
import RoleLanding from './components/RoleLanding';
import StocktakePage from './pages/Stocktake';
import Suppliers from './pages/Suppliers';
import Printers from './pages/Printers';
import Settings from './pages/Settings';
import PurchaseOrders from './pages/PurchaseOrders';
import Menu from './pages/Menu';
import Schedule from './pages/Schedule';
import Reservations from './pages/Reservations';
import { SessionProvider } from './session/SessionProvider';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Hydrate the current session, then subscribe to future changes
    // (sign-in / sign-out / token refresh).
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-app-bg text-sm text-app-ink-muted">
        جارٍ التحميل…
      </div>
    );
  }

  if (!session) {
    return <Login />;
  }

  // SessionProvider sits inside the auth gate: it resolves GET /api/me once for
  // the whole app, so every page knows the caller's role without refetching it.
  return (
    <PreferencesProvider>
      <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            {/* The index is a REDIRECT, not a page: where "home" is depends on
                the role, and sending a waiter to a management dashboard is the
                thing this phase exists to stop. */}
            <Route index element={<RoleLanding />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="reservations" element={<Reservations />} />
            <Route path="floor" element={<Floor />} />
            <Route path="kitchen" element={<Kitchen />} />
            <Route path="till" element={<Till />} />
            <Route path="menu" element={<Menu />} />
            <Route path="orders" element={<Orders />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="recipes" element={<Recipes />} />
            <Route path="members" element={<Members />} />
            <Route path="reports" element={<Reports />} />
            <Route path="insights" element={<Insights />} />
            <Route path="stocktake" element={<StocktakePage />} />
            <Route path="suppliers" element={<Suppliers />} />
            <Route path="purchase-orders" element={<PurchaseOrders />} />
            <Route path="printers" element={<Printers />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionProvider>
    </PreferencesProvider>
  );
}
