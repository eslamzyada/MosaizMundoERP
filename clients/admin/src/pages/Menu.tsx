import { useCallback, useEffect, useState } from 'react';
import LoadError from '../components/LoadError';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import type { ReactNode } from 'react';
import Button from '../components/Button';
import MenuItemModal from '../components/MenuItemModal';
import { HttpCatalogRepository } from '../api/HttpCatalogRepository';
import type { CatalogRepository } from '../api/CatalogRepository';
import { useSession } from '../session/SessionProvider';
import type { CatalogItem } from '../types';
import { useSearchFocus } from '../lib/useSearchFocus';
import MenuChangeQueue from '../components/MenuChangeQueue';
import { menuChangeRepository } from '../api/MenuChangeRepository';

const repository: CatalogRepository = new HttpCatalogRepository();

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Menu() {
  // Arriving from the search box: scroll to the chosen row and mark it.
  const { focusProps } = useSearchFocus();
  // Managing the menu (create / re-price) is administrative (0010). Others read.
  const { can, me } = useSession();
  const mayManage = can('administer');
  // Proposing is wider than administering: the kitchen knows what can be
  // cooked. Deciding is narrower. The database is the authority on both.
  const mayPropose = mayManage || me?.role === 'kitchen';
  const mayDecide = me?.role === 'owner' || me?.role === 'regional_manager';
  const [queueNonce, setQueueNonce] = useState(0);

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    repository
      .getItems()
      .then((data) => {
        setItems(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(classifyLoadFailure(e));
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
      .catch((e) => {
        if (!active) return;
        setError(classifyLoadFailure(e));
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

  /**
   * Saving became proposing (0035).
   *
   * Nothing here writes the menu — the application role cannot. This files a
   * request, and the dish changes only once somebody else approves it.
   */
  async function handleSave(payload: {
    name: string;
    price: number;
    sku: string | null;
    reason: string;
  }) {
    await menuChangeRepository.propose(
      editing
        ? {
            kind: 'update',
            sellable_item_id: editing.id,
            name: payload.name,
            sku: payload.sku,
            price: payload.price,
            reason: payload.reason,
          }
        : {
            kind: 'create',
            name: payload.name,
            sku: payload.sku,
            price: payload.price,
            reason: payload.reason,
          },
    );
    setQueueNonce((n) => n + 1);
  }

  const busy = loading || error !== null;

  return (
    <div className="p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-app-ink">القائمة</h1>
          <p className="mt-1 text-sm text-app-ink-muted">
            أصناف البيع وأسعارها. السعر هنا هو المعتمد عند الدفع في نقطة البيع.
          </p>
        </div>
        {mayPropose && (
          <Button variant="primary" onClick={openCreate} disabled={busy}>
            اقتراح صنف
          </Button>
        )}
      </header>

      <div aria-live="polite" className="sr-only">
        {loading ? 'جارٍ تحميل القائمة' : error ? 'تعذّر تحميل القائمة' : `${items.length} صنف`}
      </div>

      {!mayManage && !busy && (
        <p className="mb-4 rounded-xl border border-app-border bg-app-surface-alt/60 px-4 py-3 text-xs text-app-ink-muted">
          عرض فقط — اقتراح تغييرات القائمة متاح للمطبخ والمديرين.
        </p>
      )}

      <MenuChangeQueue
        key={queueNonce}
        canDecide={mayDecide}
        currentUserId={me?.user_id ?? null}
        onApplied={refresh}
      />

      <div className="mt-6 overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-app-border text-sm">
            <caption className="sr-only">أصناف القائمة وأسعارها</caption>
            <thead className="bg-app-surface-alt/60">
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
            <tbody className="divide-y divide-app-border/70">
              {error ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12">
                    <LoadError failure={error} onRetry={refresh} />
                  </td>
                </tr>
              ) : loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-app-ink-muted">
                    جارٍ التحميل…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-app-ink-muted">
                    لا توجد أصناف بعد.
                    {mayPropose ? ' اقترح أول صنف من زر «اقتراح صنف».' : ''}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    {...focusProps(item.id, 'transition-colors hover:bg-app-bg/60')}
                  >
                    <td className="px-6 py-4 font-semibold text-app-ink">{item.name}</td>
                    <td className="px-6 py-4 font-numerals text-app-ink-muted">{item.sku ?? '—'}</td>
                    <td className="px-6 py-4">
                      <span className="font-numerals font-semibold text-app-ink">
                        {money(item.price)}
                      </span>
                      <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
                    </td>
                    <td className="px-6 py-4">
                      <CostCell item={item} />
                    </td>
                    <td className="px-6 py-4">
                      <MarginCell item={item} />
                    </td>
                    <td className="px-6 py-4 text-end">
                      {mayPropose && (
                        <button
                          type="button"
                          onClick={() => openEdit(item)}
                          aria-label={`اقتراح تعديل: ${item.name}`}
                          className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                        >
                          اقتراح تعديل
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
      <span className="text-xs text-app-ink-muted" title="أضف وصفة لهذا الصنف لحساب تكلفته">
        لا توجد وصفة
      </span>
    );
  }

  const partial = item.uncosted_line_count > 0;
  return (
    <div className="flex flex-col gap-0.5">
      <span>
        <span className="font-numerals font-semibold text-app-ink">
          {money(item.total_cost)}
        </span>
        <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
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
            profit < 0 ? 'text-destructive-strong' : 'text-app-ink',
          ].join(' ')}
        >
          {money(profit)}
        </span>
        <span className="ms-1 text-xs font-medium text-app-ink-muted">ج.م</span>
      </span>
      <span className="font-numerals text-[11px] text-app-ink-muted">
        نسبة التكلفة {foodCostPct.toFixed(1)}%
      </span>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-app-ink-muted"
    >
      {children}
    </th>
  );
}
