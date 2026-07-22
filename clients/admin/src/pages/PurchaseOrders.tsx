import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import Button from '../components/Button';
import Badge from '../components/ui/Badge';
import NewPurchaseOrderModal from '../components/NewPurchaseOrderModal';
import { HttpPurchaseOrderRepository } from '../api/HttpPurchaseOrderRepository';
import type { PurchaseOrderRepository } from '../api/PurchaseOrderRepository';
import { HttpSupplierRepository } from '../api/HttpSupplierRepository';
import { HttpInventoryRepository } from '../api/HttpInventoryRepository';
import { useSession } from '../session/SessionProvider';
import type {
  InventoryStock,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  Supplier,
} from '../types';

const repository: PurchaseOrderRepository = new HttpPurchaseOrderRepository();
const supplierRepository = new HttpSupplierRepository();
const inventoryRepository = new HttpInventoryRepository();

const STATUS_META: Record<
  PurchaseOrderStatus,
  { label: string; variant: 'success' | 'twilight' | 'neutral' | 'warning' }
> = {
  draft: { label: 'مسودّة', variant: 'neutral' },
  placed: { label: 'قيد التوريد', variant: 'twilight' },
  received: { label: 'مستلَم', variant: 'success' },
  cancelled: { label: 'ملغى', variant: 'neutral' },
};

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 3 });
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function errorMessage(err: unknown, fallback: string): string {
  const msg = axios.isAxiosError(err)
    ? (err.response?.data as { error?: string } | undefined)?.error
    : undefined;
  return msg ?? fallback;
}

export default function PurchaseOrders() {
  const { can } = useSession();
  const mayOrder = can('administer');

  const [orders, setOrders] = useState<PurchaseOrderSummary[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<InventoryStock[]>([]);
  const [open, setOpen] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [list, sup, stock] = await Promise.all([
        repository.list(),
        supplierRepository.list(),
        inventoryRepository.getStock(),
      ]);
      setOrders(list);
      setSuppliers(sup.filter((s) => s.is_active));
      setItems(stock);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await load();
      if (open) {
        // Re-read the open order so its lines reflect what just happened.
        setOpen(await repository.get(open.id));
      }
    } catch (err) {
      setNotice(errorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const outstanding = useMemo(() => orders.filter((o) => o.status === 'placed'), [orders]);

  return (
    <div className="p-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">أوامر الشراء</h1>
          <p className="mt-1 text-sm text-slate-500">
            ما تم طلبه من المورّدين، وما وصل منه فعلًا — الفرق بينهما هو المتبقّي لدى المورّد.
          </p>
        </div>
        {mayOrder && !loading && !error && (
          <Button variant="primary" disabled={busy} onClick={() => setModalOpen(true)}>
            أمر شراء جديد
          </Button>
        )}
      </header>

      {!mayOrder && !loading && (
        <p className="mb-4 rounded-xl border border-surface-sand-border bg-surface-sand-alt/60 px-4 py-3 text-xs text-slate-500">
          عرض فقط — إصدار أوامر الشراء واستلامها متاح للمالك والمديرين.
        </p>
      )}

      {notice && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-destructive-soft bg-destructive-soft/40 px-4 py-3 text-xs font-semibold text-destructive-strong"
        >
          {notice}
        </p>
      )}

      {error ? (
        <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center">
          <p className="mb-3 text-sm text-destructive-strong">تعذّر تحميل البيانات.</p>
          <Button variant="secondary" onClick={load}>
            إعادة المحاولة
          </Button>
        </div>
      ) : loading ? (
        <div className="rounded-2xl border border-dashed border-surface-sand-border bg-white p-12 text-center text-sm text-slate-400">
          جارٍ التحميل…
        </div>
      ) : (
        <>
          {outstanding.length > 0 && (
            <p className="mb-4 rounded-xl border border-twilight-200 bg-twilight-50 px-4 py-3 text-xs font-semibold text-twilight-700">
              {outstanding.length} أمر شراء قيد التوريد.
            </p>
          )}

          <OrderTable
            orders={orders}
            onOpen={async (id) => {
              setNotice(null);
              try {
                setOpen(await repository.get(id));
              } catch (err) {
                setNotice(errorMessage(err, 'تعذّر فتح أمر الشراء.'));
              }
            }}
          />

          {open && (
            <OrderDetail
              order={open}
              mayOrder={mayOrder}
              busy={busy}
              onClose={() => setOpen(null)}
              onPlace={() => run(() => repository.place(open.id), 'تعذّر اعتماد الأمر.')}
              onCancel={() => run(() => repository.cancel(open.id), 'تعذّر إلغاء الأمر.')}
              onReceive={(receipts) =>
                run(() => repository.receive(open.id, receipts), 'تعذّر تسجيل الاستلام.')
              }
            />
          )}
        </>
      )}

      <NewPurchaseOrderModal
        open={modalOpen}
        suppliers={suppliers}
        items={items}
        onClose={() => setModalOpen(false)}
        onCreate={async (payload) => {
          const created = await repository.create(payload);
          await load();
          setOpen(await repository.get(created.id));
        }}
      />
    </div>
  );
}

function OrderTable({
  orders,
  onOpen,
}: {
  orders: PurchaseOrderSummary[];
  onOpen: (id: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-sand-border text-sm">
          <caption className="sr-only">أوامر الشراء</caption>
          <thead className="bg-surface-sand-alt/60">
            <tr>
              <Th>المورّد</Th>
              <Th>التوريد المتوقّع</Th>
              <Th>الأصناف</Th>
              <Th>القيمة</Th>
              <Th>الحالة</Th>
              <Th>
                <span className="sr-only">عرض</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-sand-border/70">
            {orders.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-sm text-slate-400">
                  لا توجد أوامر شراء بعد.
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr key={o.id} className="transition-colors hover:bg-surface-sand/60">
                  <td className="px-6 py-4 font-semibold text-surface-dark">{o.supplier_name}</td>
                  <td className="px-6 py-4 font-numerals text-slate-500">{day(o.expected_at)}</td>
                  <td className="px-6 py-4 text-slate-500">
                    <span className="font-numerals">{o.line_count}</span>
                    {/* The number that matters on a placed order: what has not
                        turned up yet. */}
                    {o.outstanding_lines > 0 && o.status === 'placed' && (
                      <span className="ms-2 text-[11px] font-bold text-warning-strong">
                        {o.outstanding_lines} لم يصل
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-numerals text-slate-600">
                    {money(Number(o.order_value))}
                  </td>
                  <td className="px-6 py-4">
                    <Badge variant={STATUS_META[o.status].variant}>
                      {STATUS_META[o.status].label}
                    </Badge>
                  </td>
                  <td className="px-6 py-4 text-end">
                    <button
                      type="button"
                      onClick={() => onOpen(o.id)}
                      aria-label={`عرض أمر الشراء من ${o.supplier_name}`}
                      className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100"
                    >
                      عرض
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The open order: what was ordered against what has arrived, and — while it is
 * placed — the fields to record a delivery.
 */
function OrderDetail({
  order,
  mayOrder,
  busy,
  onClose,
  onPlace,
  onCancel,
  onReceive,
}: {
  order: PurchaseOrder;
  mayOrder: boolean;
  busy: boolean;
  onClose: () => void;
  onPlace: () => void;
  onCancel: () => void;
  onReceive: (receipts: Array<{ line_id: string; quantity: number; unit_cost?: number | null }>) => void;
}) {
  // Delivered quantities are entered per line and submitted together, because a
  // delivery arrives as one event — and the API treats it as all-or-nothing.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts({});
    setCosts({});
  }, [order.id, order.status]);

  const receipts = order.lines
    .map((line) => {
      const raw = drafts[line.id];
      const quantity = Number(raw);
      if (!raw || !Number.isFinite(quantity) || quantity <= 0) return null;
      const rawCost = costs[line.id];
      const unitCost = rawCost && Number.isFinite(Number(rawCost)) ? Number(rawCost) : null;
      return { line_id: line.id, quantity, unit_cost: unitCost };
    })
    .filter((r): r is { line_id: string; quantity: number; unit_cost: number | null } => r !== null);

  const canReceive = mayOrder && order.status === 'placed' && receipts.length > 0;

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-sand-border px-6 py-4">
        <div>
          <h2 className="text-sm font-bold text-surface-dark">
            {order.suppliers.name}{' '}
            <Badge variant={STATUS_META[order.status].variant}>
              {STATUS_META[order.status].label}
            </Badge>
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            التوريد المتوقّع: <span className="font-numerals">{day(order.expected_at)}</span>
            {order.notes && ` · ${order.notes}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {mayOrder && order.status === 'draft' && (
            <Button variant="primary" disabled={busy} onClick={onPlace}>
              اعتماد الأمر
            </Button>
          )}
          {mayOrder && (order.status === 'draft' || order.status === 'placed') && (
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              إلغاء الأمر
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </div>

      {order.status === 'draft' && (
        <p className="border-b border-surface-sand-border bg-surface-sand-alt/40 px-6 py-3 text-xs text-slate-500">
          مسودّة — لا يمكن تسجيل استلام قبل اعتماد الأمر.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-sand-border text-sm">
          <caption className="sr-only">أصناف أمر الشراء</caption>
          <thead className="bg-surface-sand-alt/60">
            <tr>
              <Th>المكوّن</Th>
              <Th>المطلوب</Th>
              <Th>الموّرد</Th>
              <Th>المتبقّي</Th>
              <Th>السعر المتفق</Th>
              {order.status === 'placed' && mayOrder && <Th>استلام الآن</Th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-sand-border/70">
            {order.lines.map((line) => {
              const short = Number(line.quantity_outstanding);
              return (
                <tr key={line.id} className="transition-colors hover:bg-surface-sand/60">
                  <td className="px-6 py-3 font-semibold text-surface-dark">
                    {line.raw_item_name}
                    <span className="ms-2 text-xs font-normal text-slate-400">
                      {line.unit_of_measure}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-numerals text-slate-500">
                    {qty(Number(line.quantity_ordered))}
                  </td>
                  <td className="px-6 py-3 font-numerals text-slate-600">
                    {qty(Number(line.quantity_received))}
                  </td>
                  <td className="px-6 py-3">
                    <Outstanding value={short} />
                  </td>
                  <td className="px-6 py-3 font-numerals text-slate-500">
                    {money(Number(line.unit_price))}
                  </td>
                  {order.status === 'placed' && mayOrder && (
                    <td className="px-6 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          dir="ltr"
                          aria-label={`الكمية المستلمة من ${line.raw_item_name}`}
                          placeholder="0"
                          value={drafts[line.id] ?? ''}
                          disabled={busy}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [line.id]: e.target.value }))
                          }
                          className="w-24 rounded-lg border border-surface-sand-border bg-white px-2 py-1 font-numerals text-start text-sm font-semibold text-surface-dark focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30 disabled:opacity-50"
                        />
                        {/* The invoice often differs from the quote; leaving
                            this blank keeps the agreed price. */}
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          dir="ltr"
                          aria-label={`السعر الفعلي لـ ${line.raw_item_name}`}
                          placeholder={`${money(Number(line.unit_price))}`}
                          value={costs[line.id] ?? ''}
                          disabled={busy}
                          onChange={(e) => setCosts((c) => ({ ...c, [line.id]: e.target.value }))}
                          className="w-24 rounded-lg border border-surface-sand-border bg-white px-2 py-1 font-numerals text-start text-sm text-slate-600 focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30 disabled:opacity-50"
                        />
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {order.status === 'placed' && mayOrder && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-sand-border px-6 py-4">
          <p className="text-xs text-slate-500">
            أدخل ما وصل فعلًا. اترك خانة السعر فارغة إذا لم يتغيّر عن المتفق عليه.
          </p>
          <Button variant="primary" disabled={!canReceive || busy} onClick={() => onReceive(receipts)}>
            {busy ? 'جارٍ التسجيل…' : 'تسجيل الاستلام'}
          </Button>
        </div>
      )}
    </section>
  );
}

/** What is still owed on a line — or, if negative, what arrived beyond the order. */
function Outstanding({ value }: { value: number }) {
  if (Math.abs(value) < 1e-9) {
    return <span className="text-xs font-semibold text-success-strong">مكتمل</span>;
  }
  if (value < 0) {
    // Over-delivery is recorded rather than refused, so it has to be readable.
    return (
      <span className="font-numerals text-sm font-bold text-twilight-700" title="وصل أكثر من المطلوب">
        +{qty(Math.abs(value))} زائد
      </span>
    );
  }
  return (
    <span className="font-numerals text-sm font-bold text-warning-strong">{qty(value)}</span>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-slate-500"
    >
      {children}
    </th>
  );
}
