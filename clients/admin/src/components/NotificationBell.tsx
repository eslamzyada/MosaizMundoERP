import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { notificationRepository, type Notification } from '../api/NotificationRepository';
import { safeInternalPath } from '../lib/safeInternalPath';

/**
 * The bell (0036).
 *
 * Every role has one and every role sees only their own — that is enforced by
 * an own-row policy in the database, not by anything here. What this file is
 * responsible for is the part a policy cannot do:
 *
 *   1. Telling you there is something WITHOUT you having to go and look. The
 *      approval cycle in 0035 created a queue; before this, a proposal sat
 *      until somebody happened to open the menu page.
 *   2. Taking you TO it. A notification you cannot act on is an interruption.
 *
 * Delivery is a poll, not a socket. Sixty seconds is well inside the time it
 * takes anyone to walk to the kitchen and ask, and it costs one indexed query
 * per user per minute — a socket would be a second system that can be down.
 */

const POLL_MS = 60_000;

/** Arabic relative time, so "when" reads without arithmetic. */
const rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
function ago(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit);
    value /= size;
  }
  return rtf.format(Math.round(value), 'year');
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [inbox, setInbox] = useState<{ unread: number; notifications: Notification[] }>({
    unread: 0,
    notifications: [],
  });
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // `alive` rather than a cleanup on the promise: a poll in flight when the
  // component unmounts must not write state afterwards.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await notificationRepository.list();
      if (!alive.current) return;
      setInbox(next);
      setFailed(false);
    } catch {
      if (!alive.current) return;
      // A bell that shows a red error is worse than one that shows nothing:
      // the inbox is not the task anybody is here to do. Keep the last known
      // list and say so quietly inside the panel.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      // Nobody is reading a hidden tab, and a laptop asleep for an hour should
      // not wake to sixty queued requests.
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Coming back to the tab is exactly when the count is most likely stale.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  useEffect(() => {
    if (!open) return undefined;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function openNotification(item: Notification) {
    setOpen(false);
    if (!item.read_at) {
      try {
        await notificationRepository.markRead(item.id);
      } catch {
        // Already read, or gone. Neither is a reason to refuse to navigate.
      }
    }
    void refresh();

    // Second gate on the same rule the CHECK constraint enforces in the
    // database: a notification navigates INSIDE the admin or not at all. A
    // link is a place somebody clicks without reading it.
    //
    // This used to test startsWith('/') && !startsWith('//'), which is the
    // right instinct and misses `/\evil.com` — the exact bypass the react-router
    // advisory is about, and a form the database CHECK (link LIKE '/%') also
    // accepts. safeInternalPath knows about that one and about the whitespace
    // and control characters a browser strips before resolving a URL.
    const target = safeInternalPath(item.link);
    if (target) navigate(target);
  }

  async function markAll() {
    try {
      await notificationRepository.markAllRead();
    } finally {
      void refresh();
    }
  }

  const { unread, notifications } = inbox;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `الإشعارات، ${unread} غير مقروء` : 'الإشعارات'}
        aria-expanded={open}
        data-testid="notification-bell"
        className="relative grid h-9 w-9 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            data-testid="unread-badge"
            className="font-numerals absolute -top-0.5 -end-0.5 min-w-[18px] rounded-full bg-sunset-500 px-1 text-[10px] font-bold leading-[18px] text-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          data-testid="notification-panel"
          role="dialog"
          aria-label="الإشعارات"
          className="absolute top-11 z-50 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-app-border bg-app-surface text-app-ink shadow-2xl"
          style={{ insetInlineStart: 0 }}
        >
          <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
            <p className="text-sm font-semibold">الإشعارات</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="text-xs text-twilight-500 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500"
              >
                تعليم الكل كمقروء
              </button>
            )}
          </div>

          {failed && (
            <p className="border-b border-app-border bg-app-bg px-4 py-2 text-xs text-app-ink-muted">
              تعذّر تحديث الإشعارات — سيُعاد المحاولة تلقائيًا.
            </p>
          )}

          {notifications.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-app-ink-muted">لا توجد إشعارات</p>
          ) : (
            <ul>
              {notifications.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => openNotification(item)}
                    data-testid={`notification-${item.id}`}
                    className={[
                      'block w-full border-b border-app-border px-4 py-3 text-start transition-colors hover:bg-app-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500',
                      item.read_at ? 'opacity-60' : '',
                    ].join(' ')}
                  >
                    <span className="flex items-start gap-2">
                      {/* The one piece of state that matters at a glance. */}
                      <span
                        aria-hidden
                        className={[
                          'mt-1.5 h-2 w-2 flex-shrink-0 rounded-full',
                          item.read_at ? 'bg-transparent' : 'bg-sunset-500',
                        ].join(' ')}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{item.subject}</span>
                        {item.body && (
                          <span className="mt-0.5 block truncate text-xs text-app-ink-muted">
                            {item.body}
                          </span>
                        )}
                        <span className="font-numerals mt-1 block text-[11px] text-app-ink-muted">
                          {ago(item.created_at)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
