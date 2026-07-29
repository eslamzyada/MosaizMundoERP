import { useCallback, useEffect, useMemo, useState } from 'react';
import LoadError from '../components/LoadError';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import type { ReactNode } from 'react';
import MetricWidget from '../components/MetricWidget';
import Badge from '../components/ui/Badge';
import { HttpOrderRepository } from '../api/HttpOrderRepository';
import { HttpInventoryRepository } from '../api/HttpInventoryRepository';
import { orderStatusMeta } from '../lib/orderStatus';
import type { InventoryDeficit, InventoryStock, Order } from '../types';

const orderRepository = new HttpOrderRepository();
const inventoryRepository = new HttpInventoryRepository();

export default function Dashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [deficits, setDeficits] = useState<InventoryDeficit[]>([]);
  const [stock, setStock] = useState<InventoryStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);
  /** When these figures were actually read. A dashboard that cannot say how old
   *  it is invites you to trust a number from an hour ago. */
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [orderData, deficitData, stockData] = await Promise.all([
        orderRepository.getOrders(),
        inventoryRepository.getDeficits(),
        inventoryRepository.getStock(),
      ]);
      setOrders(orderData);
      setDeficits(deficitData);
      setStock(stockData);
      setFetchedAt(new Date());
    } catch (e) {
      setError(classifyLoadFailure(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-read when the page is looked at again.
   *
   * This was a snapshot taken once on mount: change stock on another page, or
   * leave this tab open while someone else works, and it kept showing figures
   * that were no longer true — with nothing on screen admitting it. Refetching
   * on focus and on tab visibility makes "I just changed that" and "this is
   * what it says" agree, which is the whole expectation a dashboard sets.
   */
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const stockValue = useMemo(
    () => stock.reduce((sum, s) => sum + Number(s.stock_value ?? 0), 0),
    [stock],
  );
  const lowStockCount = useMemo(
    () =>
      stock.filter((s) => s.reorder_threshold > 0 && Number(s.on_hand) < s.reorder_threshold)
        .length,
    [stock],
  );

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
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">لوحة التحكم</h1>
          <p className="mt-1 text-sm text-slate-500">
            نظرة عامة على أداء اليوم.
            {fetchedAt && (
              <span className="ms-2 text-xs text-slate-400">
                آخر تحديث{' '}
                <span className="font-numerals">
                  {fetchedAt.toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-surface-sand-border bg-white px-3 py-1.5 text-xs font-bold text-slate-600 transition-colors hover:bg-surface-sand-alt focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
        >
          تحديث
        </button>
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
          loading={loading || error !== null}
          icon={<TrendingUpIcon />}
        />
        <MetricWidget
          label="عدد الطلبات"
          value={completed.length.toLocaleString('en-US')}
          accent="twilight"
          loading={loading || error !== null}
          icon={<BagIcon />}
        />
        <MetricWidget
          label="نواقص المخزون"
          value={deficits.length.toLocaleString('en-US')}
          accent="amber"
          loading={loading || error !== null}
          icon={<AlertIcon />}
        />
        {/* Inventory had no presence here at all, which is why changing it
            appeared to leave the dashboard untouched — there was nothing on the
            page that could move. */}
        <MetricWidget
          label="قيمة المخزون"
          value={stockValue.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
          suffix="ج.م"
          accent="twilight"
          loading={loading || error !== null}
          icon={<BoxIcon />}
        />
        <MetricWidget
          label="تحت الحد الأدنى"
          value={lowStockCount.toLocaleString('en-US')}
          accent="amber"
          loading={loading || error !== null}
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
                {error ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-10">
                      <LoadError failure={error} onRetry={load} />
                    </td>
                  </tr>
                ) : loading ? (
                  <tr>
                    <td colSpan={3} className="px-6 py-10 text-center text-slate-400">
                      جارٍ التحميل…
                    </td>
                  </tr>
                ) : (
                  recentOrders.map((o) => {
                    const meta = orderStatusMeta(o.status);
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

function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
      <path d="M21 8V16L12 21L3 16V8L12 3L21 8Z" strokeLinejoin="round" />
      <path d="M3 8L12 13L21 8" strokeLinejoin="round" />
      <path d="M12 13V21" strokeLinejoin="round" />
    </svg>
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
