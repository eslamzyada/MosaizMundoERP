import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Badge from '../components/ui/Badge';
import { HttpInventoryRepository } from '../api/HttpInventoryRepository';
import type { InventoryRepository } from '../api/InventoryRepository';
import type { InventoryDeficit } from '../types';

// Depend on the interface, not the concrete class.
const repository: InventoryRepository = new HttpInventoryRepository();

export default function Inventory() {
  const [deficits, setDeficits] = useState<InventoryDeficit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    repository
      .getDeficits()
      .then((data) => {
        if (!active) return;
        setDeficits(data);
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

  const totalMissing = deficits.reduce((sum, d) => sum + d.missing_quantity, 0);
  const ingredientsAffected = new Set(deficits.map((d) => d.raw_item_id)).size;

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-surface-dark">نواقص المخزون</h1>
        <p className="mt-1 text-sm text-slate-500">
          مكوّنات تم بيعها بما يتجاوز المخزون المُسجّل، بانتظار التسوية.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="نواقص مفتوحة"
          value={loading || error ? '—' : deficits.length.toLocaleString('en-US')}
          accent="twilight"
        />
        <StatCard
          label="إجمالي الوحدات الناقصة"
          value={loading || error ? '—' : totalMissing.toLocaleString('en-US')}
          accent="destructive"
        />
        <StatCard
          label="المكوّنات المتأثرة"
          value={loading || error ? '—' : ingredientsAffected.toLocaleString('en-US')}
          accent="amber"
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-surface-sand-border text-sm">
            <thead className="bg-surface-sand-alt/60">
              <tr>
                <Th>المكوّن</Th>
                <Th>الوحدة</Th>
                <Th>الكمية الناقصة</Th>
                <Th>الحالة</Th>
                <Th>تاريخ التسجيل</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-sand-border/70">
              {error ? (
                <tr>
                  <td colSpan={5} className="px-6 py-14 text-center text-destructive-strong">
                    تعذّر تحميل البيانات. تأكّد من تسجيل الدخول ومن تشغيل الخادم.
                  </td>
                </tr>
              ) : loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-14 text-center text-slate-400">
                    جارٍ تحميل النواقص…
                  </td>
                </tr>
              ) : deficits.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-14 text-center text-slate-400">
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
                        {d.missing_quantity.toLocaleString('en-US')}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <Badge variant="destructive">عجز</Badge>
                    </td>
                    <td className="px-6 py-4 text-slate-500">
                      <span className="font-numerals">{formatDate(d.recorded_at)}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
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
  accent,
}: {
  label: string;
  value: string;
  accent: keyof typeof ACCENT_BAR;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-surface-sand-border bg-white p-5 shadow-sm">
      <span className={`absolute inset-y-0 end-0 w-1 ${ACCENT_BAR[accent]}`} aria-hidden />
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 font-numerals text-3xl font-bold text-surface-dark">{value}</div>
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}
