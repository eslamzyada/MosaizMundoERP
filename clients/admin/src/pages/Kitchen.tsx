import { useCallback, useEffect, useState } from 'react';
import LoadError from '../components/LoadError';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import { HttpOrderRepository } from '../api/HttpOrderRepository';
import type { Order, OrderItem } from '../types';

/**
 * The pass: what has been fired, oldest first.
 *
 * READ ONLY, and honestly so. The kitchen role writes nothing (0034) — there is
 * no "prepared" state on an order line, only `fired_at`, so this screen can
 * show what was sent and cannot show what has been cooked. Rather than fake a
 * tick that goes nowhere, the page says what it does not yet know.
 *
 * Marking a ticket done is the obvious next step and it belongs in its own
 * change: a new state on the table the checkout procedures write is a change to
 * the sale path, and it deserves its own migration and its own assertions.
 */

const repository = new HttpOrderRepository();

interface Ticket {
  orderId: string;
  label: string;
  firedAt: string;
  items: OrderItem[];
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

/** One ticket per open order that has anything fired on it. */
function ticketsFrom(orders: Order[]): Ticket[] {
  return orders
    .filter((o) => o.status === 'open')
    .map((o) => {
      const fired = o.order_items.filter((i) => i.fired_at !== null && i.fired_at !== undefined);
      return {
        orderId: o.id,
        label: o.note ?? `#${o.id.slice(0, 8)}`,
        // The oldest fired line is what the ticket's clock runs from.
        firedAt: fired
          .map((i) => i.fired_at as string)
          .sort()[0] ?? o.created_at,
        items: fired,
      };
    })
    .filter((t) => t.items.length > 0)
    .sort((a, b) => new Date(a.firedAt).getTime() - new Date(b.firedAt).getTime());
}

export default function Kitchen() {
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

  // A pass screen is looked at, not interacted with, so it has to refresh
  // itself. Thirty seconds is slow enough to be free and fast enough that a
  // ticket does not appear late.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const tickets = ticketsFrom(orders);

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">المطبخ</h1>
        <p className="mt-1 text-sm text-app-ink-muted">
          ما أُرسل للتحضير، الأقدم أولًا. تُحدَّث الشاشة تلقائيًا.
        </p>
      </header>

      {error ? (
        <LoadError failure={error} onRetry={load} />
      ) : loading ? (
        <p className="text-sm text-app-ink-muted">جارٍ التحميل…</p>
      ) : tickets.length === 0 ? (
        <p className="rounded-xl border border-dashed border-app-border p-10 text-center text-sm text-app-ink-muted">
          لا توجد طلبات قيد التحضير.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tickets.map((ticket) => {
            const age = minutesSince(ticket.firedAt);
            // Fifteen minutes on the pass is when a plate starts being late.
            const late = age >= 15;
            return (
              <li
                key={ticket.orderId}
                data-testid={`ticket-${ticket.orderId}`}
                data-late={late}
                className={`rounded-xl border-2 bg-app-surface p-4 shadow-sm ${
                  late ? 'border-sunset-500' : 'border-app-border'
                }`}
              >
                <div className="mb-3 flex items-baseline justify-between gap-2 border-b border-app-border pb-2">
                  <span className="truncate font-bold text-app-ink">{ticket.label}</span>
                  <span
                    className={`flex-shrink-0 font-numerals text-sm font-bold ${
                      late ? 'text-sunset-600 dark:text-sunset-400' : 'text-app-ink-muted'
                    }`}
                  >
                    {age}د
                  </span>
                </div>

                <ul className="space-y-1.5">
                  {ticket.items.map((item) => (
                    <li key={item.id} className="flex items-baseline gap-2 text-sm">
                      <span className="font-numerals font-bold text-app-ink">{item.quantity}×</span>
                      <span className="flex-1 text-app-ink">
                        {item.sellable_items?.name ?? 'صنف'}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-6 text-xs text-app-ink-muted">
        لا يمكن تعليم الطلب كمُنجز بعد — لا توجد حالة «جاهز» على الأصناف حتى الآن. هذه الشاشة
        للعرض فقط.
      </p>
    </div>
  );
}
