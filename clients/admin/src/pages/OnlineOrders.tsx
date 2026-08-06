import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  publicOrderRepository,
  type PublicOrder,
  type Storefront,
} from '../api/PublicOrderRepository';
import { useSession } from '../session/SessionProvider';
import { classifyLoadFailure } from '../lib/loadFailure';
import LoadError from '../components/LoadError';

/**
 * The queue of requests from the public (0040).
 *
 * Accepting is the moment a stranger's request becomes a sale — it runs the
 * till's own checkout, deducts stock and captures cost, under the identity of
 * whoever pressed the button. So the row shows what was ordered and what it
 * was quoted at BEFORE the button, not after: agreeing to something you have
 * not read is the failure this screen exists to prevent.
 */

const money = (n: number) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_LABEL: Record<string, string> = {
  pending: 'بانتظار القرار',
  accepted: 'مقبول',
  rejected: 'مرفوض',
  fulfilled: 'تم التسليم',
  cancelled: 'ملغي',
};

export default function OnlineOrders() {
  const { can } = useSession();
  const canManage = can('administer');

  const [orders, setOrders] = useState<PublicOrder[]>([]);
  const [shop, setShop] = useState<Storefront | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof classifyLoadFailure> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<PublicOrder | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const [q, s] = await Promise.all([
        publicOrderRepository.queue(showAll ? 'all' : 'pending'),
        publicOrderRepository.storefront(),
      ]);
      setOrders(q);
      setShop(s);
      setFailure(null);
    } catch (err) {
      setFailure(classifyLoadFailure(err));
    }
  }, [showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new order is somebody standing at a counter waiting. Thirty seconds.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  async function accept(order: PublicOrder) {
    setBusy(order.id);
    setProblem(null);
    try {
      await publicOrderRepository.accept(order.id);
      await load();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setProblem(
          err.response.data?.code === 'checkout_refused'
            ? 'تعذّر تمرير الطلب على الكاشير — راجع المخزون أو الأصناف.'
            : 'هذا الطلب تم البتّ فيه بالفعل من جهاز آخر.',
        );
        await load();
      } else {
        setProblem('تعذّر قبول الطلب.');
      }
    } finally {
      setBusy(null);
    }
  }

  async function confirmReject() {
    if (!rejecting) return;
    setBusy(rejecting.id);
    setProblem(null);
    try {
      await publicOrderRepository.reject(rejecting.id, reason.trim());
      setRejecting(null);
      setReason('');
      await load();
    } catch {
      setProblem('تعذّر رفض الطلب.');
    } finally {
      setBusy(null);
    }
  }

  async function toggleAccepting() {
    if (!shop) return;
    try {
      await publicOrderRepository.saveStorefront({ is_accepting: !shop.is_accepting });
      await load();
    } catch {
      setProblem('تعذّر تغيير حالة الاستقبال.');
    }
  }

  if (failure) {
    return (
      <div className="p-8">
        <LoadError failure={failure} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="p-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-app-ink">الطلبات أونلاين</h1>
          <p className="mt-1 text-sm text-app-ink-muted">
            طلبات من الزبائن. لا يُخصم مخزون ولا تُسجَّل مبيعة حتى تقبلها.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-app-ink-muted">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          إظهار كل الطلبات
        </label>
      </header>

      {problem && (
        <p className="mb-4 rounded-lg border border-sunset-300 bg-sunset-50 px-4 py-2 text-sm text-sunset-800">
          {problem}
        </p>
      )}

      {shop ? (
        <section
          data-testid="shopfront"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface p-4"
        >
          <span>
            <span className="block text-sm font-medium text-app-ink">
              {shop.is_accepting ? 'المطعم يستقبل طلبات الآن' : 'الاستقبال متوقف'}
            </span>
            <span className="font-numerals block text-xs text-app-ink-muted">
              /order/{shop.slug}
            </span>
          </span>
          {canManage && (
            <button
              type="button"
              onClick={toggleAccepting}
              data-testid="toggle-accepting"
              className="rounded-lg border border-app-border px-4 py-2 text-sm font-semibold text-app-ink hover:bg-app-surface-alt"
            >
              {shop.is_accepting ? 'إيقاف الاستقبال' : 'بدء الاستقبال'}
            </button>
          )}
        </section>
      ) : (
        canManage && (
          <section className="mb-6 rounded-xl border border-dashed border-app-border p-6 text-center">
            <p className="text-sm text-app-ink">لم تُنشئ صفحة طلبات بعد.</p>
            <p className="mt-1 text-xs text-app-ink-muted">
              تحتاج عنوانًا على الويب واسمًا يظهر للزبائن — من الإعدادات.
            </p>
          </section>
        )
      )}

      {rejecting && (
        <div
          data-testid="reject-dialog"
          role="alertdialog"
          className="mb-4 rounded-xl border border-sunset-300 bg-sunset-50 p-4"
        >
          <p className="text-sm font-semibold text-sunset-900">
            رفض طلب {rejecting.customer_name}؟
          </p>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="السبب — سيراه فريقك، لا الزبون"
            aria-label="سبب الرفض"
            className="mt-2 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-ink"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={confirmReject}
              disabled={reason.trim().length < 3 || busy === rejecting.id}
              className="rounded-lg bg-sunset-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              رفض الطلب
            </button>
            <button
              type="button"
              onClick={() => {
                setRejecting(null);
                setReason('');
              }}
              className="rounded-lg border border-app-border bg-app-surface px-4 py-1.5 text-xs font-semibold text-app-ink"
            >
              إلغاء
            </button>
          </div>
        </div>
      )}

      {orders.length === 0 ? (
        <p className="rounded-xl border border-dashed border-app-border p-8 text-center text-sm text-app-ink-muted">
          لا توجد طلبات {showAll ? '' : 'بانتظار القرار'}.
        </p>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li
              key={o.id}
              data-testid={`order-${o.id}`}
              className="rounded-xl border border-app-border bg-app-surface p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <span>
                  <span className="block text-sm font-semibold text-app-ink">
                    {o.customer_name}
                  </span>
                  <span className="font-numerals block text-xs text-app-ink-muted">
                    {o.customer_phone} ·{' '}
                    {new Date(o.created_at).toLocaleTimeString('ar-EG', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-numerals text-sm font-bold text-app-ink">
                    {money(o.quoted_total)} ج.م
                  </span>
                  <span className="rounded-full bg-app-bg px-2 py-0.5 text-[11px] text-app-ink-muted">
                    {STATUS_LABEL[o.status] ?? o.status}
                  </span>
                </span>
              </div>

              {/* What was actually asked for. Shown before the buttons, not
                  hidden behind them. */}
              <ul className="mt-3 space-y-1 border-t border-app-border pt-3">
                {o.lines.map((l, i) => (
                  <li key={i} className="flex justify-between text-xs text-app-ink">
                    <span>
                      <span className="font-numerals">{l.quantity} ×</span> {l.item_name}
                    </span>
                    <span className="font-numerals text-app-ink-muted">
                      {money(l.unit_price * l.quantity)}
                    </span>
                  </li>
                ))}
              </ul>

              {o.note && (
                <p className="mt-2 rounded-lg bg-app-bg px-3 py-2 text-xs text-app-ink">
                  {o.note}
                </p>
              )}

              {o.status === 'pending' && (
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => accept(o)}
                    disabled={busy === o.id}
                    data-testid={`accept-${o.id}`}
                    className="rounded-lg bg-twilight-600 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    {busy === o.id ? 'جارٍ القبول…' : 'قبول وتمرير على الكاشير'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejecting(o)}
                    className="rounded-lg border border-app-border px-4 py-1.5 text-xs font-semibold text-app-ink"
                  >
                    رفض
                  </button>
                </div>
              )}

              {o.rejection_reason && (
                <p className="mt-2 text-xs text-app-ink-muted">السبب: {o.rejection_reason}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
