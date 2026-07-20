import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Button from '../components/Button';
import MenuItemModal from '../components/MenuItemModal';
import { HttpCatalogRepository } from '../api/HttpCatalogRepository';
import type { CatalogRepository } from '../api/CatalogRepository';
import { useSession } from '../session/SessionProvider';
import type { CatalogItem } from '../types';

const repository: CatalogRepository = new HttpCatalogRepository();

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Menu() {
  // Managing the menu (create / re-price) is administrative (0010). Others read.
  const { can } = useSession();
  const mayManage = can('administer');

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(false);
    repository
      .getItems()
      .then((data) => {
        setItems(data);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    let active = true;
    repository
      .getItems()
      .then((data) => {
        if (!active) return;
        setItems(data);
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
  }, []);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(item: CatalogItem) {
    setEditing(item);
    setModalOpen(true);
  }

  async function handleSave(payload: { name: string; price: number; sku: string | null }) {
    if (editing) {
      await repository.updateItem(editing.id, payload);
    } else {
      await repository.createItem(payload);
    }
    refresh();
  }

  const busy = loading || error;

  return (
    <div className="p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">القائمة</h1>
          <p className="mt-1 text-sm text-slate-500">
            أصناف البيع وأسعارها. السعر هنا هو المعتمد عند الدفع في نقطة البيع.
          </p>
        </div>
        {mayManage && (
          <Button variant="primary" onClick={openCreate} disabled={busy}>
            إضافة صنف
          </Button>
        )}
      </header>

      <div aria-live="polite" className="sr-only">
        {loading ? 'جارٍ تحميل القائمة' : error ? 'تعذّر تحميل القائمة' : `${items.length} صنف`}
      </div>

      {!mayManage && !busy && (
        <p className="mb-4 rounded-xl border border-surface-sand-border bg-surface-sand-alt/60 px-4 py-3 text-xs text-slate-500">
          عرض فقط — إدارة القائمة متاحة للمالك والمديرين.
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-surface-sand-border text-sm">
            <caption className="sr-only">أصناف القائمة وأسعارها</caption>
            <thead className="bg-surface-sand-alt/60">
              <tr>
                <Th>الصنف</Th>
                <Th>SKU</Th>
                <Th>السعر</Th>
                <Th>التكلفة</Th>
                <Th>الهامش</Th>
                <Th>
                  <span className="sr-only">إجراءات</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-sand-border/70">
              {error ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <p className="mb-3 text-destructive-strong">
                      تعذّر تحميل البيانات. تأكّد من تسجيل الدخول ومن تشغيل الخادم.
                    </p>
                    <Button variant="secondary" onClick={refresh}>
                      إعادة المحاولة
                    </Button>
                  </td>
                </tr>
              ) : loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                    جارٍ التحميل…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                    لا توجد أصناف بعد.
                    {mayManage ? ' أضف أول صنف من زر «إضافة صنف».' : ''}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="transition-colors hover:bg-surface-sand/60">
                    <td className="px-6 py-4 font-semibold text-surface-dark">{item.name}</td>
                    <td className="px-6 py-4 font-numerals text-slate-500">{item.sku ?? '—'}</td>
                    <td className="px-6 py-4">
                      <span className="font-numerals font-semibold text-surface-dark">
                        {money(item.price)}
                      </span>
                      <span className="ms-1 text-xs font-medium text-slate-400">ج.م</span>
                    </td>
                    <td className="px-6 py-4">
                      <CostCell item={item} />
                    </td>
                    <td className="px-6 py-4">
                      <MarginCell item={item} />
                    </td>
                    <td className="px-6 py-4 text-end">
                      {mayManage && (
                        <button
                          type="button"
                          onClick={() => openEdit(item)}
                          aria-label={`تعديل: ${item.name}`}
                          className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                        >
                          تعديل
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <MenuItemModal
        open={modalOpen}
        item={editing}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
      />
    </div>
  );
}

/**
 * What a dish costs to make, in one of three states that must never be confused
 * with each other. `total_cost` is 0 both for an item with no recipe and for one
 * whose ingredients are all out of stock — printing a bare "0.00" in either case
 * would read as "free", and a menu priced off that is priced off nothing.
 */
function CostCell({ item }: { item: CatalogItem }) {
  if (item.recipe_line_count === 0) {
    return (
      <span className="text-xs text-slate-400" title="أضف وصفة لهذا الصنف لحساب تكلفته">
        لا توجد وصفة
      </span>
    );
  }

  const partial = item.uncosted_line_count > 0;
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <span className="font-numerals font-semibold text-surface-dark">
          {money(item.total_cost)}
        </span>
        <span className="ms-1 text-xs font-medium text-slate-400">ج.م</span>
      </span>
      {partial && (
        <span
          className="text-[11px] font-semibold text-warning-strong"
          title={`${item.uncosted_line_count} مكوّن بلا رصيد في المخزون`}
        >
          جزئية — التكلفة أعلى
        </span>
      )}
    </div>
  );
}

/**
 * Profit per portion, and food cost as a share of the price. Both are withheld
 * unless the cost is complete AND a price is set: a margin computed from a
 * partial cost flatters the dish, which is the opposite of useful here.
 */
function MarginCell({ item }: { item: CatalogItem }) {
  const unknown = item.recipe_line_count === 0 || item.uncosted_line_count > 0;
  if (unknown || item.price <= 0) {
    return <span className="text-slate-300">—</span>;
  }

  const profit = item.price - item.total_cost;
  const foodCostPct = (item.total_cost / item.price) * 100;

  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <span
          className={[
            'font-numerals font-semibold',
            profit < 0 ? 'text-destructive-strong' : 'text-surface-dark',
          ].join(' ')}
        >
          {money(profit)}
        </span>
        <span className="ms-1 text-xs font-medium text-slate-400">ج.م</span>
      </span>
      <span className="font-numerals text-[11px] text-slate-500">
        نسبة التكلفة {foodCostPct.toFixed(1)}%
      </span>
    </div>
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
