import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Button from '../components/Button';
import Badge from '../components/ui/Badge';
import SupplierModal from '../components/SupplierModal';
import { HttpSupplierRepository } from '../api/HttpSupplierRepository';
import type { SupplierRepository } from '../api/SupplierRepository';
import { useSession } from '../session/SessionProvider';
import type { Supplier, SupplierPriceRow } from '../types';

const repository: SupplierRepository = new HttpSupplierRepository();

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Suppliers() {
  const { can } = useSession();
  const mayManage = can('administer');

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [prices, setPrices] = useState<SupplierPriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    Promise.all([repository.list(), repository.priceHistory()])
      .then(([s, p]) => {
        setSuppliers(s);
        setPrices(p);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  useEffect(load, [load]);

  async function handleSave(payload: {
    name: string;
    contact_name: string | null;
    phone: string | null;
    notes: string | null;
  }) {
    if (editing) {
      await repository.update(editing.id, payload);
    } else {
      await repository.create(payload);
    }
    load();
  }

  async function toggleActive(supplier: Supplier) {
    await repository.update(supplier.id, { is_active: !supplier.is_active });
    load();
  }

  return (
    <div className="p-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">المورّدون</h1>
          <p className="mt-1 text-sm text-slate-500">
            من تشتري منه، وكم يتقاضى — لمتابعة تغيّر أسعار الشراء بمرور الوقت.
          </p>
        </div>
        {mayManage && !loading && !error && (
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            إضافة مورّد
          </Button>
        )}
      </header>

      {!mayManage && !loading && (
        <p className="mb-4 rounded-xl border border-surface-sand-border bg-surface-sand-alt/60 px-4 py-3 text-xs text-slate-500">
          عرض فقط — إدارة المورّدين متاحة للمالك والمديرين.
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
          <SupplierTable
            suppliers={suppliers}
            mayManage={mayManage}
            onEdit={(s) => {
              setEditing(s);
              setModalOpen(true);
            }}
            onToggle={toggleActive}
          />
          <PriceTable prices={prices} />
        </>
      )}

      <SupplierModal
        open={modalOpen}
        supplier={editing}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
      />
    </div>
  );
}

function SupplierTable({
  suppliers,
  mayManage,
  onEdit,
  onToggle,
}: {
  suppliers: Supplier[];
  mayManage: boolean;
  onEdit: (s: Supplier) => void;
  onToggle: (s: Supplier) => void;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-sand-border text-sm">
          <caption className="sr-only">قائمة المورّدين</caption>
          <thead className="bg-surface-sand-alt/60">
            <tr>
              <Th>المورّد</Th>
              <Th>مسؤول التواصل</Th>
              <Th>الهاتف</Th>
              <Th>الحالة</Th>
              {mayManage && (
                <Th>
                  <span className="sr-only">إجراءات</span>
                </Th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-sand-border/70">
            {suppliers.length === 0 ? (
              <tr>
                <td colSpan={mayManage ? 5 : 4} className="px-6 py-12 text-center text-sm text-slate-400">
                  لا يوجد مورّدون بعد. أضف مورّدًا لتتمكّن من نسب المشتريات إليه.
                </td>
              </tr>
            ) : (
              suppliers.map((s) => (
                <tr
                  key={s.id}
                  className={[
                    'transition-colors hover:bg-surface-sand/60',
                    s.is_active ? '' : 'opacity-60',
                  ].join(' ')}
                >
                  <td className="px-6 py-4 font-semibold text-surface-dark">
                    {s.name}
                    {s.notes && (
                      <span className="mt-0.5 block text-xs font-normal text-slate-400">
                        {s.notes}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-slate-500">{s.contact_name ?? '—'}</td>
                  <td className="px-6 py-4 font-numerals text-slate-500" dir="ltr">
                    <span className="block text-start">{s.phone ?? '—'}</span>
                  </td>
                  <td className="px-6 py-4">
                    <Badge variant={s.is_active ? 'success' : 'neutral'}>
                      {s.is_active ? 'نشط' : 'موقوف'}
                    </Badge>
                  </td>
                  {mayManage && (
                    <td className="px-6 py-4 text-end">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onEdit(s)}
                          aria-label={`تعديل المورّد ${s.name}`}
                          className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100"
                        >
                          تعديل
                        </button>
                        {/* Retire, never delete: past lots keep this name, so the
                            record of what previous months cost stays intact. */}
                        <button
                          type="button"
                          onClick={() => onToggle(s)}
                          aria-label={`${s.is_active ? 'إيقاف' : 'تفعيل'} المورّد ${s.name}`}
                          className="rounded-lg px-2.5 py-1 text-xs font-bold text-slate-500 transition-colors hover:bg-surface-sand-alt"
                        >
                          {s.is_active ? 'إيقاف' : 'تفعيل'}
                        </button>
                      </div>
                    </td>
                  )}
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
 * The payoff: what each supplier charges for each ingredient, and whether the
 * latest delivery cost more than the one before it. A price that moved is the
 * thing worth seeing — an average would hide exactly that.
 */
function PriceTable({ prices }: { prices: SupplierPriceRow[] }) {
  // Grouped by ingredient so competing suppliers sit next to each other, which
  // is how the "who is cheapest" comparison actually gets made.
  const groups = useMemo(() => {
    const byItem = new Map<string, SupplierPriceRow[]>();
    for (const row of prices) {
      const list = byItem.get(row.raw_item_id) ?? [];
      list.push(row);
      byItem.set(row.raw_item_id, list);
    }
    return [...byItem.values()];
  }, [prices]);

  if (groups.length === 0) {
    return (
      <section className="mt-6 rounded-2xl border border-dashed border-surface-sand-border bg-white p-10 text-center text-sm text-slate-400">
        لا توجد مشتريات منسوبة إلى مورّد بعد. اختر المورّد عند استلام المخزون لتتبّع الأسعار.
      </section>
    );
  }

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
      <div className="border-b border-surface-sand-border px-6 py-4">
        <h2 className="text-sm font-bold text-surface-dark">أسعار الشراء حسب المورّد</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          يشمل المشتريات المنسوبة إلى مورّد فقط. الأرخص لكل مكوّن مُعلَّم.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-sand-border text-sm">
          <caption className="sr-only">أسعار الشراء لكل مكوّن حسب المورّد</caption>
          <thead className="bg-surface-sand-alt/60">
            <tr>
              <Th>المكوّن</Th>
              <Th>المورّد</Th>
              <Th>آخر سعر</Th>
              <Th>التغيّر</Th>
              <Th>التوريدات</Th>
              <Th>إجمالي الإنفاق</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-sand-border/70">
            {groups.map((rows) => {
              const cheapest = Math.min(...rows.map((r) => Number(r.latest_cost)));
              return rows.map((row, idx) => {
                const latest = Number(row.latest_cost);
                const isCheapest = rows.length > 1 && Math.abs(latest - cheapest) < 1e-9;
                return (
                  <tr
                    key={`${row.raw_item_id}-${row.supplier_id}`}
                    className="transition-colors hover:bg-surface-sand/60"
                  >
                    <td className="px-6 py-3 font-semibold text-surface-dark">
                      {/* Name the ingredient once per group; repeating it makes
                          the comparison harder to read, not easier. */}
                      {idx === 0 ? row.raw_item_name : ''}
                      {idx === 0 && (
                        <span className="ms-2 text-xs font-normal text-slate-400">
                          {row.unit_of_measure}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-slate-600">
                      {row.supplier_name}
                      {!row.supplier_is_active && (
                        <span className="ms-2 text-[11px] text-slate-400">(موقوف)</span>
                      )}
                      {isCheapest && (
                        <span className="ms-2 text-[11px] font-bold text-success-strong">
                          الأرخص
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      <span className="font-numerals font-semibold text-surface-dark">
                        {money(latest)}
                      </span>
                      <span className="ms-1 text-xs text-slate-400">ج.م</span>
                    </td>
                    <td className="px-6 py-3">
                      <PriceMove latest={latest} previous={row.previous_cost} />
                    </td>
                    <td className="px-6 py-3 font-numerals text-slate-500">{row.deliveries}</td>
                    <td className="px-6 py-3 font-numerals text-slate-500">
                      {money(Number(row.total_spend))}
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Movement against the previous delivery, or nothing when there isn't one. */
function PriceMove({ latest, previous }: { latest: number; previous: number | null }) {
  if (previous === null || previous === undefined) {
    // A first delivery has nothing to compare against; showing 0% would imply
    // a stable price we have no evidence for.
    return <span className="text-xs text-slate-400">أول توريد</span>;
  }
  const prev = Number(previous);
  const delta = latest - prev;
  if (Math.abs(delta) < 1e-9 || prev <= 0) {
    return <span className="text-xs text-slate-400">بدون تغيير</span>;
  }
  const pct = (delta / prev) * 100;
  const up = delta > 0;
  return (
    <span
      className={[
        'font-numerals text-sm font-bold',
        // A rising purchase price is the bad direction here — it eats margin.
        up ? 'text-destructive-strong' : 'text-success-strong',
      ].join(' ')}
      title={`السعر السابق ${money(prev)} ج.م`}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}%
    </span>
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
