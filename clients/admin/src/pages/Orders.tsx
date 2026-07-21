import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Badge from '../components/ui/Badge';
import VoidOrderModal from '../components/VoidOrderModal';
import { HttpOrderRepository } from '../api/HttpOrderRepository';
import type { OrderRepository } from '../api/OrderRepository';
import { ORDER_STATUS_META } from '../lib/orderStatus';
import { useSession } from '../session/SessionProvider';
import type { Order } from '../types';

const repository: OrderRepository = new HttpOrderRepository();

export default function Orders() {
  // Voiding is a management correction (0018): the DB refuses anyone else, the
  // UI simply doesn't offer it to them.
  const { can } = useSession();
  const mayVoid = can('administer');

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [voiding, setVoiding] = useState<Order | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    repository
      .getOrders()
      .then((data) => {
        setOrders(data);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleVoid(orderId: string, restoreStock: boolean) {
    await repository.voidOrder(orderId, restoreStock);
    load();
  }

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-surface-dark">الطلبات</h1>
        <p className="mt-1 text-sm text-slate-500">سجل الطلبات الأخيرة عبر نقاط البيع.</p>
      </header>

      <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-surface-sand-border text-sm">
            <thead className="bg-surface-sand-alt/60">
              <tr>
                <Th>رقم الطلب</Th>
                <Th>التاريخ والوقت</Th>
                <Th>العناصر</Th>
                <Th>الإجمالي</Th>
                <Th>الحالة</Th>
                {mayVoid && (
                  <Th>
                    <span className="sr-only">إجراءات</span>
                  </Th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-sand-border/70">
              {error ? (
                <tr>
                  <td colSpan={mayVoid ? 6 : 5} className="px-6 py-14 text-center text-destructive-strong">
                    تعذّر تحميل البيانات. تأكّد من تسجيل الدخول ومن تشغيل الخادم.
                  </td>
                </tr>
              ) : loading ? (
                <tr>
                  <td colSpan={mayVoid ? 6 : 5} className="px-6 py-14 text-center text-slate-400">
                    جارٍ تحميل الطلبات…
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={mayVoid ? 6 : 5} className="px-6 py-14 text-center text-slate-400">
                    لا توجد طلبات بعد.
                  </td>
                </tr>
              ) : (
                orders.map((o) => {
                  const meta = ORDER_STATUS_META[o.status];
                  const itemCount = o.order_items.reduce((sum, it) => sum + it.quantity, 0);
                  return (
                    <tr key={o.id} className="transition-colors hover:bg-surface-sand/60">
                      <td className="px-6 py-4">
                        <span className="font-numerals font-semibold text-surface-dark">
                          #{o.id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-500">
                        <span className="font-numerals">{formatDateTime(o.created_at)}</span>
                      </td>
                      <td className="px-6 py-4 text-slate-600">
                        <span className="font-numerals">{itemCount.toLocaleString('en-US')}</span> عناصر
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-numerals font-semibold text-surface-dark">
                          {o.total_amount.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                        <span className="ms-1 text-xs font-medium text-slate-400">ج.م</span>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </td>
                      {mayVoid && (
                        <td className="px-6 py-4 text-end">
                          {o.status === 'completed' && (
                            <button
                              type="button"
                              onClick={() => setVoiding(o)}
                              aria-label={`إلغاء الطلب ${o.id.slice(0, 8)}`}
                              className="rounded-lg px-2.5 py-1 text-xs font-bold text-destructive-strong transition-colors hover:bg-destructive-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                            >
                              إلغاء
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <VoidOrderModal order={voiding} onClose={() => setVoiding(null)} onVoid={handleVoid} />
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-slate-500">
      {children}
    </th>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}
