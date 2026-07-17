import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Badge from '../components/ui/Badge';
import type { BadgeVariant } from '../components/ui/Badge';
import Button from '../components/Button';
import ReceiveStockModal from '../components/ReceiveStockModal';
import { HttpInventoryRepository } from '../api/HttpInventoryRepository';
import type { InventoryRepository } from '../api/InventoryRepository';
import type { InventoryDeficit, InventoryStock, ReceiveStockPayload } from '../types';

// Depend on the interface, not the concrete class.
const repository: InventoryRepository = new HttpInventoryRepository();

/** An ingredient is flagged this many days before its soonest lot expires. */
const EXPIRY_WARN_DAYS = 3;

type StockStatus = 'out' | 'low' | 'expiring' | 'ok';

const STATUS_META: Record<StockStatus, { label: string; variant: BadgeVariant }> = {
  out: { label: 'نفد', variant: 'destructive' },
  low: { label: 'منخفض', variant: 'warning' },
  expiring: { label: 'قرب الانتهاء', variant: 'amber' },
  ok: { label: 'متوفر', variant: 'success' },
};

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return (new Date(iso).getTime() - Date.now()) / 86_400_000;
}

/** Only open lots carry an expiry, so an out-of-stock item is never "expiring". */
function isExpiringSoon(s: InventoryStock): boolean {
  const days = daysUntil(s.earliest_expiry);
  return days !== null && days <= EXPIRY_WARN_DAYS;
}

/**
 * Priority: out > low > expiring > ok. An item can be both low and expiring
 * (a small lot about to turn); the worse state wins the badge, but the expiry
 * stat counts it regardless so nothing hides behind a "low" label.
 * A threshold of 0 disables the low-stock alert (migration 0009).
 */
function statusOf(s: InventoryStock): StockStatus {
  if (s.on_hand <= 0) return 'out';
  if (s.reorder_threshold > 0 && s.on_hand < s.reorder_threshold) return 'low';
  if (isExpiringSoon(s)) return 'expiring';
  return 'ok';
}

const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Inventory() {
  const [stock, setStock] = useState<InventoryStock[]>([]);
  const [deficits, setDeficits] = useState<InventoryDeficit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [preselected, setPreselected] = useState<string | undefined>(undefined);

  const load = useCallback(
    () => Promise.all([repository.getStock(), repository.getDeficits()]),
    [],
  );

  useEffect(() => {
    let active = true;
    load()
      .then(([stockData, deficitData]) => {
        if (!active) return;
        setStock(stockData);
        setDeficits(deficitData);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  // Let the modal surface its own failure: rethrow rather than swallow.
  async function handleReceive(payload: ReceiveStockPayload) {
    await repository.receiveStock(payload);
    const [stockData, deficitData] = await load();
    setStock(stockData);
    setDeficits(deficitData);
  }

  function openReceive(itemId?: string) {
    setPreselected(itemId);
    setModalOpen(true);
  }

  const stockValue = useMemo(() => stock.reduce((s, i) => s + i.stock_value, 0), [stock]);
  const needsAttention = useMemo(
    () => stock.filter((i) => ['low', 'out'].includes(statusOf(i))).length,
    [stock],
  );
  const expiringCount = useMemo(() => stock.filter(isExpiringSoon).length, [stock]);

  const busy = loading || error;

  return (
    <div className="p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">المخزون</h1>
          <p className="mt-1 text-sm text-slate-500">
            المتوفر من كل مكوّن، محسوبًا من لوطات الشراء المفتوحة، مع تنبيهات النقص والصلاحية.
          </p>
        </div>
        <Button variant="primary" onClick={() => openReceive(undefined)} disabled={busy}>
          استلام مخزون
        </Button>
      </header>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="قيمة المخزون"
          value={busy ? '—' : money(stockValue)}
          suffix="ج.م"
          accent="twilight"
        />
        <StatCard
          label="تحت الحد الأدنى"
          value={busy ? '—' : qty(needsAttention)}
          accent="destructive"
        />
        <StatCard
          label="قرب انتهاء الصلاحية"
          value={busy ? '—' : qty(expiringCount)}
          accent="amber"
        />
        <StatCard
          label="نواقص مفتوحة"
          value={busy ? '—' : qty(deficits.length)}
          accent="amber"
        />
      </div>

      {/* ---- Stock on hand ---- */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-bold text-surface-dark">المتوفر في المخزن</h2>
        <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-surface-sand-border text-sm">
              <thead className="bg-surface-sand-alt/60">
                <tr>
                  <Th>المكوّن</Th>
                  <Th>المتوفر</Th>
                  <Th>الحد الأدنى</Th>
                  <Th>اللوطات</Th>
                  <Th>أقرب صلاحية</Th>
                  <Th>الحالة</Th>
                  <Th>القيمة</Th>
                  <Th> </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-sand-border/70">
                {error ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-14 text-center text-destructive-strong">
                      تعذّر تحميل البيانات. تأكّد من تسجيل الدخول ومن تشغيل الخادم.
                    </td>
                  </tr>
                ) : loading ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-14 text-center text-slate-400">
                      جارٍ تحميل المخزون…
                    </td>
                  </tr>
                ) : stock.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-14 text-center text-slate-400">
                      لا توجد مكوّنات مسجّلة بعد.
                    </td>
                  </tr>
                ) : (
                  stock.map((s) => {
                    const meta = STATUS_META[statusOf(s)];
                    return (
                      <tr key={s.id} className="transition-colors hover:bg-surface-sand/60">
                        <td className="px-6 py-4 font-semibold text-surface-dark">{s.name}</td>
                        <td className="px-6 py-4">
                          <span className="font-numerals font-semibold text-surface-dark">
                            {qty(s.on_hand)}
                          </span>
                          <span className="ms-1 text-xs text-slate-400">{s.unit_of_measure}</span>
                        </td>
                        <td className="px-6 py-4 font-numerals text-slate-500">
                          {s.reorder_threshold > 0 ? qty(s.reorder_threshold) : '—'}
                        </td>
                        <td className="px-6 py-4 font-numerals text-slate-500">
                          {qty(s.open_batches)}
                        </td>
                        <td className="px-6 py-4 font-numerals text-slate-500">
                          {formatDate(s.earliest_expiry)}
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                        </td>
                        <td className="px-6 py-4">
                          <span className="font-numerals text-surface-dark">
                            {money(s.stock_value)}
                          </span>
                          <span className="ms-1 text-xs text-slate-400">ج.م</span>
                        </td>
                        <td className="px-6 py-4 text-end">
                          <button
                            type="button"
                            onClick={() => openReceive(s.id)}
                            className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100"
                          >
                            استلام
                          </button>
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

      {/* ---- Deficit ledger ---- */}
      <section>
        <h2 className="mb-1 text-sm font-bold text-surface-dark">نواقص المخزون</h2>
        <p className="mb-3 text-xs text-slate-500">
          مكوّنات تم بيعها بما يتجاوز المخزون المُسجّل، بانتظار التسوية.
        </p>
        <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-surface-sand-border text-sm">
              <thead className="bg-surface-sand-alt/60">
                <tr>
                  <Th>المكوّن</Th>
                  <Th>الوحدة</Th>
                  <Th>الكمية الناقصة</Th>
                  <Th>تاريخ التسجيل</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-sand-border/70">
                {loading || error ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-10 text-center text-slate-400">
                      {error ? '—' : 'جارٍ التحميل…'}
                    </td>
                  </tr>
                ) : deficits.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-10 text-center text-slate-400">
                      لا توجد نواقص. المخزون مُسوّى بالكامل.
                    </td>
                  </tr>
                ) : (
                  deficits.map((d) => (
                    <tr key={d.id} className="transition-colors hover:bg-surface-sand/60">
                      <td className="px-6 py-4 font-semibold text-surface-dark">
                        {d.raw_inventory_items.name}
                      </td>
                      <td className="px-6 py-4 text-slate-500">
                        {d.raw_inventory_items.unit_of_measure}
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-numerals font-semibold text-destructive-strong">
                          {qty(d.missing_quantity)}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-numerals text-slate-500">
                        {formatDate(d.recorded_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <ReceiveStockModal
        open={modalOpen}
        items={stock}
        initialItemId={preselected}
        onClose={() => setModalOpen(false)}
        onReceive={handleReceive}
      />
    </div>
  );
}

const ACCENT_BAR: Record<string, string> = {
  twilight: 'bg-twilight-500',
  destructive: 'bg-destructive',
  amber: 'bg-amber-500',
};

function StatCard({
  label,
  value,
  suffix,
  accent,
}: {
  label: string;
  value: string;
  suffix?: string;
  accent: keyof typeof ACCENT_BAR;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-surface-sand-border bg-white p-5 shadow-sm">
      <span className={`absolute inset-y-0 end-0 w-1 ${ACCENT_BAR[accent]}`} aria-hidden />
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 font-numerals text-3xl font-bold text-surface-dark">
        {value}
        {suffix && <span className="ms-1 text-sm font-medium text-slate-400">{suffix}</span>}
      </div>
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

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}
