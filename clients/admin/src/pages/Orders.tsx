import { useCallback, useEffect, useState } from 'react';
import LoadError from '../components/LoadError';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import type { ReactNode } from 'react';
import Badge from '../components/ui/Badge';
import VoidOrderModal from '../components/VoidOrderModal';
import { HttpOrderRepository } from '../api/HttpOrderRepository';
import type { OrderRepository } from '../api/OrderRepository';
import { orderStatusMeta } from '../lib/orderStatus';
import { voidReasonLabel, type VoidReasonCode } from '../lib/voidReasons';
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
  const [error, setError] = useState<LoadFailure | null>(null);
  const [voiding, setVoiding] = useState<Order | null>(null);

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

  useEffect(() => {
    load();
  }, [load]);

  async function handleVoid(
    orderId: string,
    restoreStock: boolean,
    reason: VoidReasonCode,
    note: string,
  ) {
    await repository.voidOrder(orderId, restoreStock, reason, note);
    load();
  }

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">الطلبات</h1>
        <p className="mt-1 text-sm text-app-ink-muted">سجل الطلبات الأخيرة عبر نقاط البيع.</p>
      </header>

      <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-app-border text-sm">
            <thead className="bg-app-surface-alt/60">
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
            <tbody className="divide-y divide-app-border/70">
              {error ? (
                <tr>
                  <td colSpan={mayVoid ? 6 : 5} className="px-6 py-14">
                    <LoadError failure={error} onRetry={load} />
                  </td>
                </tr>
              ) : loading ? (
                <tr>
                  <td colSpan={mayVoid ? 6 : 5} className="px-6 py-14 text-center text-app-ink-muted">
                    جارٍ تحميل الطلبات…
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={mayVoid ? 6 : 5} className="px-6 py-14 text-center text-app-ink-muted">
                    لا توجد طلبات بعد.
                  </td>
                </tr>
              ) : (
                orders.map((o) => {
                  const meta = orderStatusMeta(o.status);
                  const itemCount = o.order_items.reduce((sum, it) => sum + it.quantity, 0);
                  return (
                    <tr key={o.id} className="transition-colors hover:bg-app-bg/60">
                      <td className="px-6 py-4">
                        <span className="font-numerals font-semibold text-app-ink">
                          #{o.id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-app-ink-muted">
                        <span className="font-numerals">{formatDateTime(o.created_at)}</span>
                      </td>
                      <td className="px-6 py-4 text-app-ink-muted">
                        <span className="font-numerals">{itemCount.toLocaleString('en-US')}</span> عناصر
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-numerals font-semibold text-app-ink">
                          {o.total_amount.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                        <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                        {/* A void without its cause is an unreadable event —
                            showing it here is what makes the list reviewable
                            rather than just a row of red badges. */}
                        {o.status === 'voided' && o.void_reason && (
                          <div className="mt-1.5 space-y-0.5">
                            <span className="block text-xs font-semibold text-app-ink-muted">
                              {voidReasonLabel(o.void_reason)}
                            </span>
                            {o.void_note && (
                              <span
                                title={o.void_note}
                                className="block max-w-[15rem] truncate text-xs text-app-ink-muted"
                              >
                                {o.void_note}
                              </span>
                            )}
                            <span className="block text-xs text-app-ink-muted">
                              {o.stock_restored ? 'أُعيدت المكوّنات' : 'المكوّنات استُهلكت'}
                            </span>
                          </div>
                        )}
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
    <th className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-app-ink-muted">
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
