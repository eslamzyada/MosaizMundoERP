import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LoadError from '../components/LoadError';
import Badge from '../components/ui/Badge';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import { HttpOrderRepository } from '../api/HttpOrderRepository';
import { orderStatusMeta } from '../lib/orderStatus';
import type { Order } from '../types';

/**
 * The waiter's screen: which tables are open, and how long they have been.
 *
 * One question, answered on arrival. The back office has thirteen destinations
 * and twelve of them are somebody else's job; this is the one a waiter actually
 * opens, so it is where they land.
 *
 * OPEN TABS FIRST, and sorted by AGE rather than by time opened. The useful
 * question on a floor is never "what happened most recently" — it is "what has
 * been waiting longest", because that is the table about to complain.
 */

const repository = new HttpOrderRepository();

/** How long a tab has been open, in words rather than a timestamp. */
function waiting(iso: string): { label: string; minutes: number } {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return { label: 'الآن', minutes };
  if (minutes < 60) return { label: `منذ ${minutes} دقيقة`, minutes };
  const hours = Math.floor(minutes / 60);
  return { label: `منذ ${hours} ساعة`, minutes };
}

export default function Floor() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    repository
      .getOrders()
      .then((data) => {
        setOrders(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(classifyLoadFailure(e));
        setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  // A floor screen that goes stale is a floor screen nobody trusts. Refetching
  // on focus costs one request and buys the assumption that what is shown is
  // what is true.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const open = orders
    .filter((o) => o.status === 'open')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const recent = orders
    .filter((o) => o.status !== 'open')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 6);

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">الصالة</h1>
        <p className="mt-1 text-sm text-app-ink-muted">
          الطاولات المفتوحة، الأقدم أولًا — لأن أطولها انتظارًا هي التي تحتاجك الآن.
        </p>
      </header>

      {error ? (
        <LoadError failure={error} onRetry={load} />
      ) : loading ? (
        <p className="text-sm text-app-ink-muted">جارٍ التحميل…</p>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-bold text-app-ink">
              مفتوحة الآن{' '}
              <span className="font-numerals text-app-ink-muted">({open.length})</span>
            </h2>

            {open.length === 0 ? (
              <p className="rounded-xl border border-dashed border-app-border p-8 text-center text-sm text-app-ink-muted">
                لا توجد طاولات مفتوحة. تُفتح الطاولات من نقطة البيع.
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {open.map((order) => {
                  const age = waiting(order.created_at);
                  const items = order.order_items.reduce((sum, it) => sum + it.quantity, 0);
                  return (
                    <li
                      key={order.id}
                      data-testid={`open-tab-${order.id}`}
                      className="rounded-xl border border-app-border bg-app-surface p-4 shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-app-ink">
                            {order.note ?? `#${order.id.slice(0, 8)}`}
                          </p>
                          <p className="mt-0.5 text-xs text-app-ink-muted">{age.label}</p>
                        </div>
                        {/* Twenty minutes is when a table starts noticing. */}
                        {age.minutes >= 20 && <Badge variant="warning">انتظار طويل</Badge>}
                      </div>

                      <p className="mt-3 text-sm text-app-ink-muted">
                        <span className="font-numerals font-semibold text-app-ink">{items}</span>{' '}
                        صنف
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-bold text-app-ink">آخر ما أُغلق</h2>
            {recent.length === 0 ? (
              <p className="text-sm text-app-ink-muted">لا شيء بعد.</p>
            ) : (
              <ul className="divide-y divide-app-border overflow-hidden rounded-xl border border-app-border bg-app-surface">
                {recent.map((order) => {
                  const meta = orderStatusMeta(order.status);
                  return (
                    <li key={order.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="truncate text-sm text-app-ink">
                        {order.note ?? `#${order.id.slice(0, 8)}`}
                      </span>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </li>
                  );
                })}
              </ul>
            )}

            <p className="mt-4 text-xs text-app-ink-muted">
              التفاصيل الكاملة في <Link to="/orders" className="font-semibold text-twilight-700 underline dark:text-twilight-300">الطلبات</Link>.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
