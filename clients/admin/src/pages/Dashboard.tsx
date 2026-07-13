import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import MetricWidget from '../components/MetricWidget';
import Badge from '../components/ui/Badge';
import { MockOrderRepository } from '../api/MockOrderRepository';
import { MockInventoryRepository } from '../api/MockInventoryRepository';
import { ORDER_STATUS_META } from '../lib/orderStatus';
import type { InventoryDeficit, Order } from '../types';

const orderRepository = new MockOrderRepository();
const inventoryRepository = new MockInventoryRepository();

export default function Dashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [deficits, setDeficits] = useState<InventoryDeficit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([orderRepository.getOrders(), inventoryRepository.getDeficits()]).then(
      ([orderData, deficitData]) => {
        if (!active) return;
        setOrders(orderData);
        setDeficits(deficitData);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const completed = useMemo(() => orders.filter((o) => o.status === 'completed'), [orders]);
  const totalSales = useMemo(
    () => completed.reduce((sum, o) => sum + o.total_amount, 0),
    [completed],
  );
  const recentOrders = useMemo(
    () =>
      [...orders]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 3),
    [orders],
  );

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-surface-dark">لوحة التحكم</h1>
        <p className="mt-1 text-sm text-slate-500">نظرة عامة على أداء اليوم.</p>
      </header>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricWidget
          label="إجمالي المبيعات"
          value={totalSales.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
          suffix="ج.م"
          accent="sunset"
          loading={loading}
          icon={<TrendingUpIcon />}
        />
        <MetricWidget
          label="عدد الطلبات"
          value={completed.length.toLocaleString('en-US')}
          accent="twilight"
          loading={loading}
          icon={<BagIcon />}
        />
        <MetricWidget
          label="نواقص المخزون"
          value={deficits.length.toLocaleString('en-US')}
          accent="amber"
          loading={loading}
          icon={<AlertIcon />}
        />
      </div>

      <section>
        <h2 className="mb-3 text-sm font-bold text-surface-dark">أحدث الطلبات</h2>
        <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-surface-sand-border text-sm">
              <thead className="bg-surface-sand-alt/60">
                <tr>
                  <Th>رقم الطلب</Th>
                  <Th>الإجمالي</Th>
                  <Th>الحالة</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-sand-border/70">
                {loading ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-10 text-center text-slate-400">
                      جارٍ التحميل…
                    </td>
                  </tr>
                ) : (
                  recentOrders.map((o) => {
                    const meta = ORDER_STATUS_META[o.status];
                    return (
                      <tr key={o.id} className="transition-colors hover:bg-surface-sand/60">
                        <td className="px-6 py-4">
                          <span className="font-numerals font-semibold text-surface-dark">
                            #{o.id.slice(0, 8)}
                          </span>
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
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
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

function TrendingUpIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M17 7h4v4" />
    </svg>
  );
}

function BagIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 7h12l-1 13H7L6 7z" />
      <path d="M9 7a3 3 0 0 1 6 0" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}
