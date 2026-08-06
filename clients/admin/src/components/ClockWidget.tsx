import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { labourRepository } from '../api/LabourRepository';
import { useSession } from '../session/SessionProvider';

/**
 * Clocking in and out (0038).
 *
 * Deliberately a small thing in the chrome rather than a page. Somebody
 * arriving for a shift is not "using the ERP" — they are starting work, and
 * making them navigate to a screen to say so is how a time clock ends up
 * filled in from memory at the end of the week.
 *
 * The elapsed time is computed from the server's `since`, never from a local
 * start time, so a client with a wrong clock displays the right number.
 */

function elapsed(sinceIso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(sinceIso)) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} س ${m} د` : `${m} د`;
}

export default function ClockWidget() {
  const { me } = useSession();
  const [state, setState] = useState<{ clocked_in: boolean; since: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // A poll in flight when this unmounts must not write state afterwards.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await labourRepository.clock();
      if (alive.current) setState(next);
    } catch (err) {
      // A 409 here means the restaurant does not run labour. That is not an
      // error to report — it is the reason this widget should not be on screen
      // at all, so it renders nothing.
      if (alive.current) setState(null);
      if (axios.isAxiosError(err) && err.response?.status !== 409) {
        // eslint-disable-next-line no-console
        console.warn('[clock] could not read state', err);
      }
    }
  }, []);

  /**
   * Re-read when the tenant's module set changes, not only on mount.
   *
   * Found by switching labour on in الإعدادات and watching the rota appear in
   * the sidebar while this stayed missing: the first read had 409'd, and
   * nothing ever asked again. Only a full page reload brought it back, which
   * is exactly the kind of "it works after you refresh" that makes people stop
   * trusting a screen.
   */
  const hasLabour = me?.modules === undefined ? true : me.modules.includes('labour');

  useEffect(() => {
    if (!hasLabour) {
      setState(null);
      return;
    }
    void refresh();
  }, [hasLabour, refresh]);

  // Re-render once a minute so the elapsed time is not frozen at whatever it
  // was when the page loaded.
  useEffect(() => {
    if (!state?.clocked_in) return undefined;
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [state?.clocked_in]);

  async function toggle() {
    setBusy(true);
    setProblem(null);
    try {
      if (state?.clocked_in) {
        await labourRepository.clockOut();
      } else {
        await labourRepository.clockIn();
      }
      await refresh();
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        // The clock disagreed with what this screen believed — another device,
        // most likely. Re-read rather than argue.
        setProblem('حالة الحضور تغيّرت من جهاز آخر — تم تحديثها.');
        await refresh();
      } else {
        setProblem('تعذّر تسجيل الحضور.');
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  // Not entitled, or not loaded: render nothing rather than a broken control.
  if (!hasLabour || !state) return null;

  return (
    <div className="px-3 pb-2" data-testid="clock-widget">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        data-testid="clock-toggle"
        aria-label={state.clocked_in ? 'تسجيل الانصراف' : 'تسجيل الحضور'}
        className={[
          'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-60',
          state.clocked_in
            ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            : 'bg-white/5 text-slate-300 hover:bg-white/10',
        ].join(' ')}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={[
              'h-2 w-2 rounded-full',
              state.clocked_in ? 'bg-emerald-400' : 'bg-slate-500',
            ].join(' ')}
          />
          {state.clocked_in ? 'انصراف' : 'حضور'}
        </span>
        {state.clocked_in && state.since && (
          <span className="font-numerals text-[11px] opacity-80">{elapsed(state.since)}</span>
        )}
      </button>
      {problem && <p className="mt-1 px-1 text-[11px] text-slate-400">{problem}</p>}
    </div>
  );
}
