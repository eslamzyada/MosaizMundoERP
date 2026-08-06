import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  reservationRepository,
  type Reservation,
  type ReservationStatus,
  type RestaurantTable,
} from '../api/ReservationRepository';
import { useSession } from '../session/SessionProvider';
import { classifyLoadFailure } from '../lib/loadFailure';
import LoadError from '../components/LoadError';

/**
 * The book (0039).
 *
 * A service, not a calendar. The question a host actually asks is "what is
 * coming tonight, and is table 7 free at eight" — so the page opens on today's
 * service and the booking form checks the table against the SERVER before
 * offering to save.
 *
 * Cancelled and no-show bookings stay visible, greyed. A restaurant that
 * cannot see its empty tables cannot do anything about them.
 */

const HOUR_MS = 3600_000;

const STATUS_LABEL: Record<ReservationStatus, string> = {
  booked: 'محجوزة',
  seated: 'جالسون',
  completed: 'انتهت',
  no_show: 'لم يحضروا',
  cancelled: 'أُلغيت',
};

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export default function Reservations() {
  const { can } = useSession();
  const canDefineFloor = can('administer');

  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [tables, setTables] = useState<RestaurantTable[]>([]);
  const [bookings, setBookings] = useState<Reservation[]>([]);
  const [failure, setFailure] = useState<ReturnType<typeof classifyLoadFailure> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const dayEnd = useMemo(() => new Date(day.getTime() + 24 * HOUR_MS), [day]);

  const load = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([
        reservationRepository.tables(),
        reservationRepository.list(day, dayEnd),
      ]);
      setTables(t);
      setBookings(b);
      setFailure(null);
    } catch (err) {
      setFailure(classifyLoadFailure(err));
    }
  }, [day, dayEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  const labelOf = (tableId: string) =>
    tables.find((t) => t.id === tableId)?.label ?? '—';

  async function setStatus(id: string, status: ReservationStatus) {
    setProblem(null);
    try {
      await reservationRepository.setStatus(id, status);
      await load();
    } catch {
      setProblem('تعذّر تحديث حالة الحجز.');
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
          <h1 className="text-2xl font-bold tracking-tight text-app-ink">الحجوزات</h1>
          <p className="mt-1 text-sm text-app-ink-muted">
            {day.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setDay(new Date(day.getTime() - 24 * HOUR_MS))}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm text-app-ink hover:bg-app-surface-alt"
          >
            أمس
          </button>
          <button
            type="button"
            onClick={() => setDay(startOfDay(new Date()))}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm text-app-ink hover:bg-app-surface-alt"
          >
            اليوم
          </button>
          <button
            type="button"
            onClick={() => setDay(new Date(day.getTime() + 24 * HOUR_MS))}
            className="rounded-lg border border-app-border px-3 py-1.5 text-sm text-app-ink hover:bg-app-surface-alt"
          >
            غدًا
          </button>
        </div>
      </header>

      {problem && (
        <p className="mb-4 rounded-lg border border-sunset-300 bg-sunset-50 px-4 py-2 text-sm text-sunset-800">
          {problem}
        </p>
      )}

      {tables.length === 0 ? (
        <section className="rounded-xl border border-dashed border-app-border p-8 text-center">
          <p className="text-sm text-app-ink">لا توجد طاولات بعد.</p>
          <p className="mt-1 text-xs text-app-ink-muted">
            {canDefineFloor
              ? 'أضف طاولات المطعم أولًا حتى تستطيع الحجز عليها.'
              : 'اطلب من الإدارة إضافة طاولات المطعم.'}
          </p>
        </section>
      ) : (
        <BookingForm tables={tables} onBooked={load} onProblem={setProblem} day={day} />
      )}

      <section className="mt-6 rounded-xl border border-app-border bg-app-surface p-4" data-testid="book">
        <h2 className="text-sm font-bold text-app-ink">حجوزات اليوم</h2>
        {bookings.length === 0 ? (
          <p className="mt-2 text-xs text-app-ink-muted">لا توجد حجوزات في هذا اليوم.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {bookings.map((b) => {
              const settled = b.status === 'cancelled' || b.status === 'no_show' || b.status === 'completed';
              return (
                <li
                  key={b.id}
                  data-testid={`booking-${b.id}`}
                  className={[
                    'flex flex-wrap items-center justify-between gap-3 rounded-lg bg-app-bg px-3 py-2',
                    // Still visible: an empty table is something to act on.
                    settled ? 'opacity-60' : '',
                  ].join(' ')}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-app-ink">
                      {b.guest_name} · {b.party_size} أشخاص
                    </span>
                    <span className="font-numerals block text-xs text-app-ink-muted">
                      {labelOf(b.table_id)} · {timeOf(b.starts_at)} — {timeOf(b.ends_at)}
                      {b.guest_phone ? ` · ${b.guest_phone}` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-app-surface px-2 py-0.5 text-[11px] text-app-ink-muted">
                      {STATUS_LABEL[b.status]}
                    </span>
                    {!settled && (
                      <>
                        {b.status === 'booked' && (
                          <button
                            type="button"
                            onClick={() => setStatus(b.id, 'seated')}
                            className="text-xs text-twilight-600 hover:underline"
                          >
                            جلسوا
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setStatus(b.id, 'no_show')}
                          className="text-xs text-app-ink-muted hover:underline"
                        >
                          لم يحضروا
                        </button>
                        <button
                          type="button"
                          onClick={() => setStatus(b.id, 'cancelled')}
                          className="text-xs text-sunset-600 hover:underline"
                        >
                          إلغاء
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canDefineFloor && <FloorPlan tables={tables} onChanged={load} onProblem={setProblem} />}
    </div>
  );
}

function BookingForm({
  tables,
  onBooked,
  onProblem,
  day,
}: {
  tables: RestaurantTable[];
  onBooked: () => Promise<void>;
  onProblem: (m: string | null) => void;
  day: Date;
}) {
  const [tableId, setTableId] = useState(tables[0]?.id ?? '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [party, setParty] = useState(2);
  const [time, setTime] = useState('20:00');
  const [hours, setHours] = useState(2);
  const [busy, setBusy] = useState(false);
  const [free, setFree] = useState<boolean | null>(null);

  const window = useMemo(() => {
    const startsAt = new Date(`${day.toISOString().slice(0, 10)}T${time}`);
    const endsAt = new Date(startsAt.getTime() + hours * HOUR_MS);
    return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
  }, [day, time, hours]);

  // Asked of the SERVER whenever the table or the window changes, so the
  // answer comes from the same rule that will accept or refuse the booking.
  useEffect(() => {
    let current = true;
    if (!tableId) return undefined;
    reservationRepository
      .isFree(tableId, window.startsAt, window.endsAt)
      .then((f) => current && setFree(f))
      .catch(() => current && setFree(null));
    return () => {
      current = false;
    };
  }, [tableId, window]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onProblem(null);
    if (!name.trim()) {
      onProblem('الحجز يحتاج اسمًا.');
      return;
    }
    setBusy(true);
    try {
      await reservationRepository.book({
        table_id: tableId,
        guest_name: name.trim(),
        guest_phone: phone.trim() || undefined,
        party_size: party,
        starts_at: window.startsAt,
        ends_at: window.endsAt,
      });
      setName('');
      setPhone('');
      await onBooked();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        onProblem('هذه الطاولة محجوزة بالفعل في جزء من هذا الوقت.');
      } else {
        onProblem('تعذّر تسجيل الحجز.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      data-testid="booking-form"
      className="flex flex-wrap items-end gap-3 rounded-xl border border-app-border bg-app-surface p-4"
    >
      <label className="text-xs text-app-ink-muted">
        الطاولة
        <select
          value={tableId}
          onChange={(e) => setTableId(e.target.value)}
          aria-label="الطاولة"
          className="mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        >
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({t.seats})
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs text-app-ink-muted">
        الاسم
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="الاسم"
          className="mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        />
      </label>
      <label className="text-xs text-app-ink-muted">
        الهاتف
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-label="الهاتف"
          className="font-numerals mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        />
      </label>
      <label className="text-xs text-app-ink-muted">
        عدد الأشخاص
        <input
          type="number"
          min={1}
          max={40}
          value={party}
          onChange={(e) => setParty(Number(e.target.value))}
          aria-label="عدد الأشخاص"
          className="font-numerals mt-1 block w-20 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        />
      </label>
      <label className="text-xs text-app-ink-muted">
        الساعة
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label="الساعة"
          className="font-numerals mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        />
      </label>
      <label className="text-xs text-app-ink-muted">
        لمدة
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          aria-label="لمدة"
          className="font-numerals mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
        >
          {[1, 1.5, 2, 3].map((h) => (
            <option key={h} value={h}>
              {h} ساعة
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        disabled={busy || free === false}
        data-testid="book-submit"
        className="rounded-lg bg-twilight-600 px-4 py-2 text-sm font-semibold text-white hover:bg-twilight-700 disabled:opacity-50"
      >
        {busy ? 'جارٍ الحجز…' : 'احجز'}
      </button>

      {/* The server's answer, not this form's arithmetic. */}
      {free === false && (
        <span data-testid="not-free" className="text-xs font-medium text-sunset-600">
          الطاولة مشغولة في هذا الوقت
        </span>
      )}
      {free === true && (
        <span data-testid="is-free" className="text-xs font-medium text-emerald-600">
          متاحة
        </span>
      )}
    </form>
  );
}

function FloorPlan({
  tables,
  onChanged,
  onProblem,
}: {
  tables: RestaurantTable[];
  onChanged: () => Promise<void>;
  onProblem: (m: string | null) => void;
}) {
  const [label, setLabel] = useState('');
  const [area, setArea] = useState('');
  const [seats, setSeats] = useState(2);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    onProblem(null);
    try {
      await reservationRepository.createTable({ label: label.trim(), area: area.trim() || undefined, seats });
      setLabel('');
      setArea('');
      await onChanged();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        onProblem('يوجد بالفعل طاولة بهذا الاسم.');
      } else {
        onProblem('تعذّر إضافة الطاولة.');
      }
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-app-border bg-app-surface p-4" data-testid="floor-plan">
      <h2 className="text-sm font-bold text-app-ink">الطاولات</h2>
      <p className="mt-1 text-xs text-app-ink-muted">
        الطاولة لا تُحذف — تُوقَف، لأن حجوزاتها السابقة جزء من السجلّ.
      </p>

      <ul className="mt-3 flex flex-wrap gap-2">
        {tables.map((t) => (
          <li
            key={t.id}
            data-testid={`table-${t.id}`}
            className="flex items-center gap-2 rounded-lg bg-app-bg px-3 py-2 text-sm text-app-ink"
          >
            <span>
              {t.label}
              <span className="font-numerals text-xs text-app-ink-muted"> · {t.seats}</span>
              {t.area && <span className="text-xs text-app-ink-muted"> · {t.area}</span>}
            </span>
            <button
              type="button"
              onClick={async () => {
                await reservationRepository.retireTable(t.id);
                await onChanged();
              }}
              className="text-xs text-sunset-600 hover:underline"
            >
              إيقاف
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={add} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-app-ink-muted">
          الاسم
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="اسم الطاولة"
            className="mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
          />
        </label>
        <label className="text-xs text-app-ink-muted">
          المكان
          <input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            aria-label="مكان الطاولة"
            className="mt-1 block rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
          />
        </label>
        <label className="text-xs text-app-ink-muted">
          المقاعد
          <input
            type="number"
            min={1}
            max={40}
            value={seats}
            onChange={(e) => setSeats(Number(e.target.value))}
            aria-label="عدد المقاعد"
            className="font-numerals mt-1 block w-20 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-app-ink"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg border border-app-border px-4 py-2 text-sm font-semibold text-app-ink hover:bg-app-surface-alt"
        >
          إضافة طاولة
        </button>
      </form>
    </section>
  );
}
