import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  labourRepository,
  type HoursReport,
  type HoursRow,
  type Shift,
  type Wage,
} from '../api/LabourRepository';
import { apiClient } from '../api/client';
import { useSession } from '../session/SessionProvider';
import { classifyLoadFailure } from '../lib/loadFailure';
import LoadError from '../components/LoadError';

/**
 * The rota (0038).
 *
 * Everyone can open this, and that is the point — a schedule only works if the
 * people on it can read it. What changes with role is whether the "add" form is
 * there, and the database refuses a write from anybody else regardless.
 *
 * The week is the unit because that is how restaurants think about rotas. Days
 * with nobody on them are still shown: an empty Tuesday is information.
 */

interface Member {
  user_id: string;
  email: string;
  role: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the local day, so a week boundary is midnight and not "now-ish". */
function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

const dayLabel = (d: Date) =>
  d.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

export default function Schedule() {
  const { me, can } = useSession();
  const canSchedule = can('administer');

  const [weekStart, setWeekStart] = useState(() => startOfDay(new Date()));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [hours, setHours] = useState<HoursRow[]>([]);
  // The whole report, not just the rows: the total and the uncosted count are
  // a pair, and showing one without the other is how a gap becomes invisible.
  const [report, setReport] = useState<HoursReport | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof classifyLoadFailure> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const weekEnd = useMemo(() => new Date(weekStart.getTime() + 7 * DAY_MS), [weekStart]);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        labourRepository.shifts(weekStart, weekEnd),
        labourRepository.hours(weekStart, weekEnd),
      ]);
      setShifts(s);
      setHours(h.by_employee);
      setReport(h);
      setFailure(null);
    } catch (err) {
      setFailure(classifyLoadFailure(err));
    }
  }, [weekStart, weekEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canSchedule) return;
    apiClient
      .get<Member[]>('/api/members')
      .then(({ data }) => setMembers(data.filter((m) => m.user_id)))
      .catch(() => setMembers([]));
  }, [canSchedule]);

  const nameOf = (userId: string) => {
    const m = members.find((x) => x.user_id === userId);
    if (m) return m.email;
    return userId === me?.user_id ? 'أنت' : userId.slice(0, 8);
  };

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)),
    [weekStart],
  );

  async function remove(id: string) {
    setProblem(null);
    try {
      await labourRepository.unschedule(id);
      await load();
    } catch {
      setProblem('تعذّر حذف الوردية.');
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
          <h1 className="text-2xl font-bold tracking-tight text-app-ink">الورديات</h1>
          <p className="mt-1 text-sm text-app-ink-muted">
            من {weekStart.toLocaleDateString('ar-EG')} إلى{' '}
            {new Date(weekEnd.getTime() - DAY_MS).toLocaleDateString('ar-EG')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm text-app-ink hover:bg-app-surface-alt"
          >
            الأسبوع السابق
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(startOfDay(new Date()))}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm text-app-ink hover:bg-app-surface-alt"
          >
            هذا الأسبوع
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm text-app-ink hover:bg-app-surface-alt"
          >
            الأسبوع التالي
          </button>
        </div>
      </header>

      {problem && (
        <p className="mb-4 rounded-lg border border-sunset-300 bg-sunset-50 px-4 py-2 text-sm text-sunset-800">
          {problem}
        </p>
      )}

      {canSchedule && (
        <ScheduleForm
          members={members}
          onScheduled={load}
          onProblem={setProblem}
          defaultDay={weekStart}
        />
      )}

      <div className="mt-6 grid gap-3" data-testid="rota">
        {days.map((day) => {
          const onThisDay = shifts.filter(
            (s) => startOfDay(new Date(s.starts_at)).getTime() === day.getTime(),
          );
          return (
            <section
              key={day.toISOString()}
              data-testid={`day-${day.toISOString().slice(0, 10)}`}
              className="rounded-xl border border-app-border bg-app-surface p-4"
            >
              <h2 className="text-sm font-bold text-app-ink">{dayLabel(day)}</h2>
              {onThisDay.length === 0 ? (
                // An empty day is information, not a gap to hide.
                <p className="mt-2 text-xs text-app-ink-muted">لا أحد على هذا اليوم.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {onThisDay.map((s) => (
                    <li
                      key={s.id}
                      data-testid={`shift-${s.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg bg-app-bg px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-app-ink">{nameOf(s.user_id)}</span>
                        <span className="font-numerals block text-xs text-app-ink-muted">
                          {timeLabel(s.starts_at)} — {timeLabel(s.ends_at)}
                          {s.note ? ` · ${s.note}` : ''}
                        </span>
                      </span>
                      {canSchedule && (
                        <button
                          type="button"
                          onClick={() => remove(s.id)}
                          className="text-xs text-sunset-600 hover:underline"
                        >
                          حذف
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {/* Hours are scoped by the database, so this table is everybody's for a
          manager and just yours for everyone else — the same request either way. */}
      <section className="mt-6 rounded-xl border border-app-border bg-app-surface p-4">
        <h2 className="text-sm font-bold text-app-ink">الساعات المسجّلة هذا الأسبوع</h2>
        {hours.length === 0 ? (
          <p className="mt-2 text-xs text-app-ink-muted">لا توجد ساعات مسجّلة في هذه الفترة.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {hours.map((h) => (
              <li
                key={h.user_id}
                data-testid={`hours-${h.user_id}`}
                className="flex items-center justify-between rounded-lg bg-app-bg px-3 py-2 text-sm"
              >
                <span className="truncate text-app-ink">{nameOf(h.user_id)}</span>
                <span className="font-numerals text-app-ink-muted">
                  {h.hours} ساعة · {h.entries} تسجيل
                  {/* Cost only when it is KNOWN. Null means either nobody has
                      recorded a rate or you may not read this person's pay,
                      and printing 0.00 for either would be a lie somebody
                      budgets against. */}
                  {h.cost !== null && (
                    <span className="ms-2 font-semibold text-app-ink">
                      {h.cost.toLocaleString('en-US', { minimumFractionDigits: 2 })} ج.م
                    </span>
                  )}
                  {h.cost === null && h.minutes > 0 && (
                    <span className="ms-2 text-app-ink-muted">التكلفة غير معروفة</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* The total says what it left out, in the same breath. */}
        {report && (report.total_cost !== null || report.uncosted_entries > 0) && (
          <p
            data-testid="labour-cost-total"
            className="mt-3 border-t border-app-border pt-3 text-xs text-app-ink-muted"
          >
            {report.total_cost !== null && (
              <>
                تكلفة العمالة:{' '}
                <span className="font-numerals font-semibold text-app-ink">
                  {report.total_cost.toLocaleString('en-US', { minimumFractionDigits: 2 })} ج.م
                </span>
              </>
            )}
            {report.uncosted_entries > 0 && (
              <span className="ms-2">
                (<span className="font-numerals">{report.uncosted_entries}</span> تسجيل بلا أجر
                معروف — غير محسوب)
              </span>
            )}
          </p>
        )}
      </section>

      {/* Pay (0042). Offered to whoever may schedule; the database is what
          decides whether they may actually set a rate — owner and regional
          manager only, and not their own. A branch manager sees this panel and
          gets a refusal with the reason, which is more useful than an absence
          they have to guess about. */}
      {canSchedule && <WagePanel members={members} onSaved={load} />}
    </div>
  );
}

function ScheduleForm({
  members,
  onScheduled,
  onProblem,
  defaultDay,
}: {
  members: Member[];
  onScheduled: () => Promise<void>;
  onProblem: (m: string | null) => void;
  defaultDay: Date;
}) {
  const [userId, setUserId] = useState('');
  const [day, setDay] = useState(() => defaultDay.toISOString().slice(0, 10));
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('17:00');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onProblem(null);
    if (!userId) {
      onProblem('اختر الموظّف أولًا.');
      return;
    }
    setBusy(true);
    try {
      await labourRepository.schedule({
        user_id: userId,
        starts_at: new Date(`${day}T${from}`).toISOString(),
        ends_at: new Date(`${day}T${to}`).toISOString(),
      });
      await onScheduled();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        // The EXCLUDE constraint, in words: a rota problem with a rota fix.
        onProblem('هذا الموظّف مسجَّل بالفعل على وردية تتقاطع مع هذا الوقت.');
      } else if (axios.isAxiosError(err) && err.response?.status === 400) {
        onProblem('الوردية يجب أن تنتهي بعد بدايتها، وألا تتجاوز ٢٤ ساعة.');
      } else {
        onProblem('تعذّر إضافة الوردية.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      data-testid="schedule-form"
      className="flex flex-wrap items-end gap-3 rounded-xl border border-app-border bg-app-surface p-4"
    >
      <label className="text-xs text-app-ink-muted">
        الموظّف
        <select
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          aria-label="الموظّف"
          className="mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        >
          <option value="">—</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.email}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-app-ink-muted">
        اليوم
        <input
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          aria-label="اليوم"
          className="font-numerals mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        />
      </label>
      <label className="text-xs text-app-ink-muted">
        من
        <input
          type="time"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="من"
          className="font-numerals mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        />
      </label>
      <label className="text-xs text-app-ink-muted">
        إلى
        <input
          type="time"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="إلى"
          className="font-numerals mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-twilight-600 px-4 py-2 text-sm font-semibold text-white hover:bg-twilight-700 disabled:opacity-50"
      >
        {busy ? 'جارٍ الإضافة…' : 'إضافة وردية'}
      </button>
    </form>
  );
}

/**
 * Pay (0042).
 *
 * A raise is a NEW ROW from a date, so this form has no "edit" — the history
 * below it is what somebody was owed, and editing it would rewrite that.
 *
 * What comes back in that history is decided by the database, not here: your
 * own always, everybody's for the owner, the regional manager and the
 * accountant. A branch manager opening this sees their own rate and nobody
 * else's, which is the correct answer rather than a bug.
 */
function WagePanel({
  members,
  onSaved,
}: {
  members: Member[];
  onSaved: () => Promise<void>;
}) {
  const [wages, setWages] = useState<Wage[]>([]);
  const [userId, setUserId] = useState('');
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWages(await labourRepository.wages());
    } catch {
      setWages([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (id: string) => members.find((m) => m.user_id === id)?.email ?? id.slice(0, 8);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);

    const value = Number(rate);
    if (!userId) return setProblem('اختر الموظف.');
    if (!Number.isFinite(value) || value < 0) return setProblem('أدخل أجرًا صحيحًا.');

    setBusy(true);
    try {
      // A date STRING. Sending a Date would serialise to UTC and land on the
      // previous day east of UTC — the raise would be dated wrongly.
      await labourRepository.setWage({ user_id: userId, hourly_rate: value, effective_from: from });
      setRate('');
      await Promise.all([load(), onSaved()]);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setProblem('يوجد أجر يبدأ من هذا التاريخ لهذا الموظف بالفعل.');
      } else if (axios.isAxiosError(err) && err.response?.status === 403) {
        setProblem('يحدّد الأجور المالك أو المدير الإقليمي فقط، ولا يحدّد أحد أجر نفسه.');
      } else {
        setProblem('تعذّر حفظ الأجر.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="mt-6 rounded-xl border border-app-border bg-app-surface p-4"
      data-testid="wage-panel"
    >
      <h2 className="text-sm font-bold text-app-ink">الأجور</h2>
      <p className="mt-1 text-xs text-app-ink-muted">
        الأجر يبدأ من تاريخ. العلاوة سجلّ جديد — لا يُعدَّل السابق، حتى لا يتغيّر ما استُحقّ فعلًا.
      </p>

      {problem && (
        <p className="mt-3 rounded-lg border border-sunset-300 bg-sunset-50 px-3 py-2 text-xs text-sunset-800">
          {problem}
        </p>
      )}

      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-app-ink-muted">
          الموظف
          <select
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            aria-label="الموظف"
            className="mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
          >
            <option value="">—</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.email}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-app-ink-muted">
          الأجر بالساعة
          <input
            type="number"
            min={0}
            step="0.25"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            aria-label="الأجر بالساعة"
            className="font-numerals mt-1 block w-28 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
          />
        </label>
        <label className="text-xs text-app-ink-muted">
          يبدأ من
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="يبدأ من"
            className="font-numerals mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          data-testid="save-wage"
          className="rounded-lg bg-twilight-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'جارٍ الحفظ…' : 'حفظ الأجر'}
        </button>
      </form>

      {wages.length === 0 ? (
        <p className="mt-3 text-xs text-app-ink-muted">لا توجد أجور مسجّلة تظهر لك.</p>
      ) : (
        <ul className="mt-3 space-y-1" data-testid="wage-history">
          {wages.map((w) => (
            <li
              key={w.id}
              className="flex items-center justify-between rounded-lg bg-app-bg px-3 py-2 text-sm"
            >
              <span className="truncate text-app-ink">{nameOf(w.user_id)}</span>
              <span className="font-numerals text-app-ink-muted">
                {Number(w.hourly_rate).toLocaleString('en-US', { minimumFractionDigits: 2 })} ج.م /
                ساعة · من {String(w.effective_from).slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
