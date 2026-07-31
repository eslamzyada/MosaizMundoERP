import { useCallback, useEffect, useMemo, useState } from 'react';
import LoadError from '../components/LoadError';
import { classifyLoadFailure } from '../lib/loadFailure';
import type { LoadFailure } from '../lib/loadFailure';
import type { ReactNode } from 'react';
import Badge from '../components/ui/Badge';
import type { BadgeVariant } from '../components/ui/Badge';
import Button from '../components/Button';
import ReceiveStockModal from '../components/ReceiveStockModal';
import IngredientModal from '../components/IngredientModal';
import WriteOffModal from '../components/WriteOffModal';
import IngredientLotsModal from '../components/IngredientLotsModal';
import RemoveIngredientModal from '../components/RemoveIngredientModal';
import { HttpInventoryRepository } from '../api/HttpInventoryRepository';
import type { InventoryRepository } from '../api/InventoryRepository';
import { HttpSupplierRepository } from '../api/HttpSupplierRepository';
import type { SupplierRepository } from '../api/SupplierRepository';
import { useSession } from '../session/SessionProvider';
import type {
  ExpiringLot,
  IngredientReferences,
  InventoryDeficit,
  InventoryStock,
  ReceiveStockPayload,
  Supplier,
  WriteOffPayload,
} from '../types';
import { useSearchFocus } from '../lib/useSearchFocus';

// Depend on the interface, not the concrete class.
const repository: InventoryRepository = new HttpInventoryRepository();
const supplierRepository: SupplierRepository = new HttpSupplierRepository();

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

/**
 * How far ahead the expiry panel looks. A week is roughly one ordering cycle:
 * long enough that something can still be cooked or discounted before it turns,
 * short enough that the list stays a to-do rather than a catalogue.
 */
const EXPIRY_WINDOW_DAYS = 7;

export default function Inventory() {
  // Arriving from the search box: scroll to the chosen row and mark it.
  const { focusProps } = useSearchFocus();
  // Receiving stock is administrative (0010). Rendering the button for a cashier
  // would only walk them into a 403.
  const { can } = useSession();
  const mayReceive = can('administer');

  const [stock, setStock] = useState<InventoryStock[]>([]);
  // Only ACTIVE suppliers are offered when receiving; retired ones stay on the
  // lots they already supplied.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [deficits, setDeficits] = useState<InventoryDeficit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [preselected, setPreselected] = useState<string | undefined>(undefined);
  const [ingredientModalOpen, setIngredientModalOpen] = useState(false);
  const [editingIngredient, setEditingIngredient] = useState<InventoryStock | null>(null);
  // Lots at or past their date (0023). Fetched separately and failing quietly:
  // it is an advisory panel, and losing it must not take the stock table down.
  const [expiring, setExpiring] = useState<ExpiringLot[]>([]);
  const [writingOff, setWritingOff] = useState<ExpiringLot | null>(null);
  const [viewingLots, setViewingLots] = useState<InventoryStock | null>(null);
  const [removalNotice, setRemovalNotice] = useState<string | null>(null);
  const [blockedRemoval, setBlockedRemoval] = useState<{
    item: InventoryStock;
    references: IngredientReferences;
  } | null>(null);

  // One round trip for both tables rather than a waterfall.
  const load = useCallback(
    () => Promise.all([repository.getStock(), repository.getDeficits()]),
    [],
  );

  const loadExpiring = useCallback(() => {
    repository
      .getExpiring(EXPIRY_WINDOW_DAYS)
      .then(setExpiring)
      .catch(() => setExpiring([]));
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    load()
      .then(([stockData, deficitData]) => {
        setStock(stockData);
        setDeficits(deficitData);
        setLoading(false);
      })
      .catch((e) => {
        setError(classifyLoadFailure(e));
        setLoading(false);
      });
    loadExpiring();
  }, [load, loadExpiring]);

  /**
   * "Remove" means delete when there is nothing to protect, and offer archiving
   * when there is. The API decides which — the foreign keys already encode the
   * rule, so asking first would duplicate it and could disagree with it.
   */
  async function handleRemove(item: InventoryStock) {
    setRemovalNotice(null);
    const result = await repository.deleteIngredient(item.id);

    if (result.outcome === 'deleted') {
      setRemovalNotice(`تم حذف «${item.name}».`);
      refresh();
      return;
    }

    // It has history. Hand the counts to a modal rather than a browser confirm:
    // this is the moment to explain WHY it cannot be deleted, and a one-line
    // dialog cannot carry that.
    setBlockedRemoval({ item, references: result.references });
  }

  async function archiveBlocked() {
    if (!blockedRemoval) return;
    await repository.setIngredientActive(blockedRemoval.item.id, false);
    setRemovalNotice(`تمت أرشفة «${blockedRemoval.item.name}» — سجله محفوظ بالكامل.`);
    setBlockedRemoval(null);
    refresh();
  }

  async function handleRestore(item: InventoryStock) {
    await repository.setIngredientActive(item.id, true);
    setRemovalNotice(`تمت إعادة «${item.name}» إلى الاستخدام.`);
    refresh();
  }

  async function handleWriteOff(payload: WriteOffPayload) {
    await repository.createWriteOff(payload);
    // Both change: the lot shrinks or disappears, and stock on hand drops.
    refresh();
  }

  useEffect(() => {
    let active = true;
    // Attribution is optional, so a supplier fetch failure degrades the picker
    // rather than failing the page.
    supplierRepository
      .list()
      .then((all) => {
        if (active) setSuppliers(all.filter((s) => s.is_active));
      })
      .catch(() => undefined);
    load()
      .then(([stockData, deficitData]) => {
        if (!active) return;
        setStock(stockData);
        setDeficits(deficitData);
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

  // Creating/editing an ingredient re-fetches so the stock table reflects it.
  async function handleSaveIngredient(payload: {
    name: string;
    unit_of_measure: string;
    reorder_threshold: number;
  }) {
    if (editingIngredient) {
      await repository.updateIngredient(editingIngredient.id, payload);
    } else {
      await repository.createIngredient(payload);
    }
    const [stockData, deficitData] = await load();
    setStock(stockData);
    setDeficits(deficitData);
  }

  function openCreateIngredient() {
    setEditingIngredient(null);
    setIngredientModalOpen(true);
  }

  function openEditIngredient(s: InventoryStock) {
    setEditingIngredient(s);
    setIngredientModalOpen(true);
  }

  const stockValue = useMemo(() => stock.reduce((s, i) => s + i.stock_value, 0), [stock]);
  const needsAttention = useMemo(
    () => stock.filter((i) => ['low', 'out'].includes(statusOf(i))).length,
    [stock],
  );
  const expiringCount = useMemo(() => stock.filter(isExpiringSoon).length, [stock]);

  const busy = loading || error !== null;

  return (
    <div className="p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-app-ink">المخزون</h1>
          <p className="mt-1 text-sm text-app-ink-muted">
            المتوفر من كل مكوّن، محسوبًا من لوطات الشراء المفتوحة، مع تنبيهات النقص والصلاحية.
          </p>
        </div>
        {mayReceive && (
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={openCreateIngredient} disabled={busy}>
              إضافة مكوّن
            </Button>
            <Button variant="primary" onClick={() => openReceive(undefined)} disabled={busy}>
              استلام مخزون
            </Button>
          </div>
        )}
      </header>

      {/* Announce load state without moving focus. */}
      <div aria-live="polite" className="sr-only">
        {loading ? 'جارٍ تحميل المخزون' : error ? 'تعذّر تحميل المخزون' : `${stock.length} مكوّن`}
      </div>

      {!mayReceive && !busy && (
        <p className="mb-4 rounded-xl border border-app-border bg-app-surface-alt/60 px-4 py-3 text-xs text-app-ink-muted">
          عرض فقط — إدارة المخزون والمكوّنات متاحة للمالك والمديرين.
        </p>
      )}

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
      {expiring.length > 0 && (
        <ExpiringPanel
          lots={expiring}
          mayWriteOff={mayReceive}
          onWriteOff={setWritingOff}
        />
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-bold text-app-ink">المتوفر في المخزن</h2>
        <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-app-border text-sm">
              <thead className="bg-app-surface-alt/60">
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
              <tbody className="divide-y divide-app-border/70">
                {error ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-12">
                      <LoadError failure={error} onRetry={refresh} />
                    </td>
                  </tr>
                ) : loading ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-14 text-center text-app-ink-muted">
                      جارٍ تحميل المخزون…
                    </td>
                  </tr>
                ) : stock.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-14 text-center text-app-ink-muted">
                      لا توجد مكوّنات مسجّلة بعد.
                    </td>
                  </tr>
                ) : (
                  stock.map((s) => {
                    const meta = STATUS_META[statusOf(s)];
                    return (
                      <tr key={s.id} {...focusProps(s.id, 'transition-colors hover:bg-app-bg/60')}>
                        <td className="px-6 py-4 font-semibold text-app-ink">
                          {s.name}
                          {/* A retired ingredient stays listed while it still
                              holds stock — that stock is real and somebody has
                              to sell, count or write it off. The badge is what
                              stops its presence reading as "in use". */}
                          {!s.is_active && (
                            <span className="ms-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-bold text-app-ink-muted">
                              مؤرشف
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className="font-numerals font-semibold text-app-ink">
                            {qty(s.on_hand)}
                          </span>
                          <span className="ms-1 text-xs text-app-ink-muted">{s.unit_of_measure}</span>
                        </td>
                        <td className="px-6 py-4 font-numerals text-app-ink-muted">
                          {s.reorder_threshold > 0 ? qty(s.reorder_threshold) : '—'}
                        </td>
                        <td className="px-6 py-4 font-numerals text-app-ink-muted">
                          {qty(s.open_batches)}
                        </td>
                        <td className="px-6 py-4 font-numerals text-app-ink-muted">
                          {formatDate(s.earliest_expiry)}
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                        </td>
                        <td className="px-6 py-4">
                          <span className="font-numerals text-app-ink">
                            {money(s.stock_value)}
                          </span>
                          <span className="ms-1 text-xs text-app-ink-muted">ج.م</span>
                        </td>
                        <td className="px-6 py-4 text-end">
                          {mayReceive && (
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => openEditIngredient(s)}
                                aria-label={`تعديل المكوّن: ${s.name}`}
                                className="rounded-lg px-2.5 py-1 text-xs font-bold text-app-ink-muted transition-colors hover:bg-black/5 hover:text-app-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                              >
                                تعديل
                              </button>
                              <button
                                type="button"
                                onClick={() => openReceive(s.id)}
                                aria-label={`استلام مخزون: ${s.name}`}
                                className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                              >
                                استلام
                              </button>
                              <button
                                type="button"
                                onClick={() => setViewingLots(s)}
                                aria-label={`دفعات وتكاليف: ${s.name}`}
                                className="rounded-lg px-2.5 py-1 text-xs font-bold text-app-ink-muted transition-colors hover:bg-black/5 hover:text-app-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                              >
                                الدفعات
                              </button>
                              {s.is_active ? (
                                <button
                                  type="button"
                                  onClick={() => handleRemove(s)}
                                  aria-label={`حذف المكوّن: ${s.name}`}
                                  className="rounded-lg px-2.5 py-1 text-xs font-bold text-destructive-strong transition-colors hover:bg-destructive-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                                >
                                  حذف
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleRestore(s)}
                                  aria-label={`إعادة المكوّن: ${s.name}`}
                                  className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
                                >
                                  إعادة
                                </button>
                              )}
                            </div>
                          )}
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
        <h2 className="mb-1 text-sm font-bold text-app-ink">نواقص المخزون</h2>
        <p className="mb-3 text-xs text-app-ink-muted">
          مكوّنات تم بيعها بما يتجاوز المخزون المُسجّل، بانتظار التسوية.
        </p>
        <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-app-border text-sm">
              <thead className="bg-app-surface-alt/60">
                <tr>
                  <Th>المكوّن</Th>
                  <Th>الوحدة</Th>
                  <Th>الكمية الناقصة</Th>
                  <Th>تاريخ التسجيل</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border/70">
                {loading || error ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-10 text-center text-app-ink-muted">
                      {error ? '—' : 'جارٍ التحميل…'}
                    </td>
                  </tr>
                ) : deficits.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-10 text-center text-app-ink-muted">
                      لا توجد نواقص. المخزون مُسوّى بالكامل.
                    </td>
                  </tr>
                ) : (
                  deficits.map((d) => (
                    <tr key={d.id} className="transition-colors hover:bg-app-bg/60">
                      <td className="px-6 py-4 font-semibold text-app-ink">
                        {d.raw_inventory_items.name}
                      </td>
                      <td className="px-6 py-4 text-app-ink-muted">
                        {d.raw_inventory_items.unit_of_measure}
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-numerals font-semibold text-destructive-strong">
                          {qty(d.missing_quantity)}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-numerals text-app-ink-muted">
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
        suppliers={suppliers}
        initialItemId={preselected}
        onClose={() => setModalOpen(false)}
        onReceive={handleReceive}
      />

      <IngredientModal
        open={ingredientModalOpen}
        ingredient={editingIngredient}
        onClose={() => setIngredientModalOpen(false)}
        onSave={handleSaveIngredient}
      />

      {removalNotice && (
        <p className="mb-4 rounded-xl border border-app-border bg-app-surface-alt/60 px-4 py-3 text-sm text-app-ink">
          {removalNotice}
        </p>
      )}

      <WriteOffModal
        lot={writingOff}
        onClose={() => setWritingOff(null)}
        onWriteOff={handleWriteOff}
      />

      <RemoveIngredientModal
        blocked={blockedRemoval}
        onClose={() => setBlockedRemoval(null)}
        onArchive={archiveBlocked}
      />

      <IngredientLotsModal
        item={viewingLots}
        onClose={() => setViewingLots(null)}
        loadLots={(id) => repository.getItemLots(id)}
        onCorrect={async (lotId, cost) => {
          const previous = await repository.correctLotCost(lotId, cost);
          // Stock value is computed from lot costs, so the table behind the
          // modal is stale the moment this succeeds.
          refresh();
          return previous;
        }}
      />
    </div>
  );
}

const ACCENT_BAR: Record<string, string> = {
  twilight: 'bg-twilight-500',
  destructive: 'bg-destructive',
  amber: 'bg-amber-500',
};

/**
 * What is about to turn, soonest first.
 *
 * This is the preventive half of write-offs: expiry_date has been recorded on
 * every lot since 0005, and until now nothing ever read it. Already-expired lots
 * lead the list rather than being filtered out — they are the most urgent thing
 * on it, stock the books still count as sellable that nobody should be cooking
 * with.
 */
function ExpiringPanel({
  lots,
  mayWriteOff,
  onWriteOff,
}: {
  lots: ExpiringLot[];
  mayWriteOff: boolean;
  onWriteOff: (lot: ExpiringLot) => void;
}) {
  const atRisk = lots.reduce((sum, l) => sum + Number(l.value_at_risk), 0);
  const expiredCount = lots.filter((l) => l.already_expired).length;

  return (
    <section className="mb-8 overflow-hidden rounded-2xl border border-warning-strong/40 bg-warning-soft/20 shadow-sm">
      <div className="border-b border-warning-strong/30 px-6 py-4">
        <h2 className="text-sm font-bold text-app-ink">
          قارب على انتهاء الصلاحية
        </h2>
        <p className="mt-1 text-xs text-app-ink-muted">
          <span className="font-numerals font-semibold">{lots.length}</span> دفعة خلال{' '}
          <span className="font-numerals">{EXPIRY_WINDOW_DAYS}</span> أيام، بقيمة{' '}
          <span className="font-numerals font-semibold">
            {atRisk.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>{' '}
          ج.م
          {expiredCount > 0 && (
            <>
              {' '}— منها{' '}
              <span className="font-numerals font-bold text-destructive-strong">
                {expiredCount}
              </span>{' '}
              انتهت صلاحيتها بالفعل ولا يزال المخزون يحتسبها.
            </>
          )}
        </p>
      </div>

      <ul className="divide-y divide-warning-strong/20">
        {lots.map((lot) => (
          <li
            key={lot.batch_id}
            className="flex flex-wrap items-center justify-between gap-3 px-6 py-3"
          >
            <div>
              <p className="text-sm font-semibold text-app-ink">
                {lot.item_name}
                {lot.supplier_name && (
                  <span className="ms-2 text-xs font-normal text-app-ink-muted">
                    · {lot.supplier_name}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-app-ink-muted">
                <span className="font-numerals">{lot.quantity_remaining}</span>{' '}
                {lot.unit_of_measure} ·{' '}
                <span className="font-numerals">
                  {Number(lot.value_at_risk).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>{' '}
                ج.م ·{' '}
                {lot.already_expired ? (
                  <span className="font-semibold text-destructive-strong">
                    انتهت منذ <span className="font-numerals">{Math.abs(lot.days_left)}</span>{' '}
                    يومًا
                  </span>
                ) : (
                  <span className="text-warning-strong">
                    تنتهي خلال <span className="font-numerals">{lot.days_left}</span> يومًا
                  </span>
                )}
              </p>
            </div>

            {mayWriteOff && (
              <button
                type="button"
                onClick={() => onWriteOff(lot)}
                className="rounded-lg border border-app-border bg-app-surface px-3 py-1.5 text-xs font-bold text-destructive-strong transition-colors hover:bg-destructive-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
              >
                إتلاف
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

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
    <div className="relative overflow-hidden rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
      <span className={`absolute inset-y-0 end-0 w-1 ${ACCENT_BAR[accent]}`} aria-hidden />
      <div className="text-xs font-semibold uppercase tracking-wide text-app-ink-muted">{label}</div>
      <div className="mt-2 font-numerals text-3xl font-bold text-app-ink">
        {value}
        {suffix && <span className="ms-1 text-sm font-medium text-app-ink-muted">{suffix}</span>}
      </div>
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

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}
