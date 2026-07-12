import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { MockInventoryRepository } from '../api/MockInventoryRepository';
import type { InventoryRepository } from '../api/InventoryRepository';
import type { InventoryDeficit } from '../types';

// Depend on the interface, not the concrete class — swap for an HTTP repo later.
const repository: InventoryRepository = new MockInventoryRepository();

export default function Inventory() {
  const [deficits, setDeficits] = useState<InventoryDeficit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    repository.getDeficits().then((data) => {
      if (!active) return;
      setDeficits(data);
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
        <h1 className="text-2xl font-semibold tracking-tight">Inventory Deficits</h1>
        <p className="mt-1 text-sm text-slate-500">
          Ingredients sold beyond recorded stock, awaiting reconciliation.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Open Deficits" value={loading ? '—' : String(deficits.length)} />
        <StatCard
          label="Total Units Short"
          value={loading ? '—' : totalMissing.toLocaleString()}
        />
        <StatCard
          label="Ingredients Affected"
          value={loading ? '—' : String(ingredientsAffected)}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Ingredient</Th>
              <Th>Unit</Th>
              <Th className="text-right">Missing Qty</Th>
              <Th>Recorded</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-slate-400">
                  Loading deficits…
                </td>
              </tr>
            ) : deficits.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-slate-400">
                  No deficits. Inventory is fully reconciled.
                </td>
              </tr>
            ) : (
              deficits.map((d) => (
                <tr key={d.id} className="transition-colors hover:bg-slate-50">
                  <td className="px-6 py-4 font-medium text-slate-900">
                    {d.raw_inventory_items.name}
                  </td>
                  <td className="px-6 py-4 text-slate-500">
                    {d.raw_inventory_items.unit_of_measure}
                  </td>
                  <td className="px-6 py-4 text-right font-semibold tabular-nums text-rose-600">
                    {d.missing_quantity.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-slate-500">{formatDate(d.recorded_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th
      className={`px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className}`}
    >
      {children}
    </th>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
