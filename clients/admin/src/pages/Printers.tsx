import { useCallback, useEffect, useState } from 'react';
import Button from '../components/Button';
import Badge from '../components/ui/Badge';
import { HttpPrinterRepository } from '../api/HttpPrinterRepository';
import type { PrinterRepository } from '../api/PrinterRepository';
import { useSession } from '../session/SessionProvider';
import type { Printer, PrinterRole } from '../types';
import { useSearchFocus } from '../lib/useSearchFocus';

const repository: PrinterRepository = new HttpPrinterRepository();

/**
 * Where tickets print.
 *
 * The page is organised by ROLE rather than by machine, because that is the
 * only question the software asks: one printer for the kitchen's ticket, one
 * for the customer's receipt. Each role shows the active printer or an empty
 * slot, and a role with no printer says plainly what stops working — an
 * unconfigured kitchen printer means firing an order tells the kitchen nothing.
 */

const ROLES: { role: PrinterRole; title: string; blurb: string; missing: string }[] = [
  {
    role: 'kitchen',
    title: 'طابعة المطبخ',
    blurb: 'تطبع تذكرة الطلب عند إرساله للمطبخ، بالملاحظات كما كُتبت.',
    missing: 'بدون طابعة مطبخ، إرسال الطلب لا يصل إلى المطبخ ورقيًا.',
  },
  {
    role: 'receipt',
    title: 'طابعة الفاتورة',
    blurb: 'تطبع فاتورة العميل عند التحصيل.',
    missing: 'بدون طابعة فاتورة، لا يمكن طباعة فاتورة للعميل.',
  },
];

export default function Printers() {
  // Arriving from the search box. Only the ACTIVE printer per role is marked —
  // a retired one sits inside a collapsed <details>, and scrolling to something
  // that is not on screen would look like nothing happened at all.
  const { focusProps } = useSearchFocus();
  const { can } = useSession();
  const mayManage = can('administer');

  const [printers, setPrinters] = useState<Printer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<PrinterRole | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    repository
      .list()
      .then((rows) => {
        setPrinters(rows);
        setError(null);
      })
      .catch(() => setError('تعذّر تحميل الطابعات'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const activeFor = (role: PrinterRole) =>
    printers.find((p) => p.role === role && p.is_active) ?? null;
  const retiredFor = (role: PrinterRole) =>
    printers.filter((p) => p.role === role && !p.is_active);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      // The API's 409 explains what to do about a duplicate active role; show
      // its wording rather than inventing a vaguer one here.
      const message =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'تعذّر تنفيذ العملية';
      setError(message);
    }
  }

  return (
    <div className="p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-app-ink">الطابعات</h1>
        <p className="mt-1 text-sm text-app-ink-muted">
          عنوان كل طابعة على شبكة المطعم. الجهاز الذي يطبع هو الكاشير نفسه، لا الخادم — لذا
          يجب أن يكون على نفس الشبكة المحلية للطابعة.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-app-ink-muted">جارٍ التحميل…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {ROLES.map(({ role, title, blurb, missing }) => {
            const active = activeFor(role);
            const retired = retiredFor(role);
            return (
              <section
                key={role}
                className="rounded-xl border border-slate-200 bg-app-surface p-6 shadow-sm"
              >
                <div className="mb-4">
                  <h2 className="text-lg font-semibold text-app-ink">{title}</h2>
                  <p className="mt-1 text-sm text-app-ink-muted">{blurb}</p>
                </div>

                {active ? (
                  <div {...focusProps(active.id, 'rounded-lg bg-slate-50 p-4')}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-app-ink">{active.name}</p>
                        {/* dir=ltr: an address reads left-to-right even on an RTL page. */}
                        <p className="mt-1 font-mono text-sm text-app-ink-muted" dir="ltr">
                          {active.host}:{active.port}
                        </p>
                      </div>
                      <Badge variant="success">نشطة</Badge>
                    </div>

                    {mayManage && (
                      <div className="mt-4 flex gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => run(() => repository.update(active.id, { is_active: false }))}
                        >
                          إيقاف
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => run(() => repository.remove(active.id))}
                        >
                          حذف
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-900">لم تُضبط بعد</p>
                    <p className="mt-1 text-sm text-amber-800">{missing}</p>
                  </div>
                )}

                {mayManage && !active && (
                  <div className="mt-4">
                    {adding === role ? (
                      <PrinterForm
                        role={role}
                        onCancel={() => setAdding(null)}
                        onSave={async (payload) => {
                          await run(() => repository.create(payload));
                          setAdding(null);
                        }}
                      />
                    ) : (
                      <Button onClick={() => setAdding(role)}>إضافة طابعة</Button>
                    )}
                  </div>
                )}

                {retired.length > 0 && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm text-app-ink-muted">
                      طابعات متوقفة ({retired.length})
                    </summary>
                    <ul className="mt-2 space-y-2">
                      {retired.map((p) => (
                        <li
                          key={p.id}
                          className="flex items-center justify-between rounded border border-slate-200 px-3 py-2 text-sm"
                        >
                          <span>
                            {p.name}{' '}
                            <span className="font-mono text-app-ink-muted" dir="ltr">
                              {p.host}:{p.port}
                            </span>
                          </span>
                          {mayManage && (
                            <button
                              type="button"
                              className="text-xs text-app-ink-muted underline"
                              onClick={() => run(() => repository.remove(p.id))}
                            >
                              حذف
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            );
          })}
        </div>
      )}

      {!mayManage && (
        <p className="mt-6 text-sm text-app-ink-muted">
          العرض فقط — تغيير مكان طباعة الطلبات من صلاحيات المديرين.
        </p>
      )}
    </div>
  );
}

/**
 * The add form. There is no role selector: the form is opened from a role's own
 * empty slot, so the role is already known and offering it again would let it
 * be set to something other than the slot it was opened from.
 */
function PrinterForm({
  role,
  onSave,
  onCancel,
}: {
  role: PrinterRole;
  onSave: (payload: { name: string; role: PrinterRole; host: string; port: number }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role === 'kitchen' ? 'المطبخ' : 'الكاشير');
  const [host, setHost] = useState('');
  // 9100 is the raw-printing port practically every network thermal printer
  // listens on, so it is filled in rather than looked up.
  const [port, setPort] = useState('9100');

  const portNumber = Number(port);
  const valid =
    name.trim() !== '' &&
    host.trim() !== '' &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= 65535;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4">
      <label className="block">
        <span className="text-sm text-app-ink-muted">الاسم</span>
        <input
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-sm text-app-ink-muted">عنوان الشبكة (IP)</span>
        <input
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono"
          dir="ltr"
          placeholder="192.168.1.50"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="text-sm text-app-ink-muted">المنفذ</span>
        <input
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono"
          dir="ltr"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <Button
          disabled={!valid}
          onClick={() => onSave({ name: name.trim(), role, host: host.trim(), port: portNumber })}
        >
          حفظ
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          إلغاء
        </Button>
      </div>
    </div>
  );
}
