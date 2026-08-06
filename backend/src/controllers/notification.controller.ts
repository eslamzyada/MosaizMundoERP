import { Request, Response } from 'express';

/**
 * Somebody's inbox (0036).
 *
 * There is no "send" endpoint here, and that is the design rather than an
 * omission. The application role has no INSERT on notifications at all —
 * everything is written by SECURITY DEFINER functions that pick recipients by
 * ROLE, at the moment the event happens. A controller that could address a
 * notification to somebody is a controller that could phish them.
 *
 * So all this does is read your own and mark it read. The own-row policy is
 * what makes "your own" true; none of these handlers filter by user, because a
 * filter in a controller is a rule that the next controller can forget.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Enough to fill a panel and scroll a little; not a full history. */
const PAGE = 50;

/**
 * GET /api/notifications?unread=true
 *
 * Returns the caller's own, newest first, with the unread count alongside so
 * the bell does not need a second request to render its badge.
 */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  const unreadOnly = req.query.unread === 'true';

  try {
    // No `where: { recipient_id }` — the RESTRICTIVE own-row policy already
    // scopes this, and repeating it here would be a second rule that can
    // silently disagree with the first.
    const [rows, unread] = await Promise.all([
      req.tx.notifications.findMany({
        where: unreadOnly ? { read_at: null } : {},
        orderBy: { created_at: 'desc' },
        take: PAGE,
      }),
      req.tx.notifications.count({ where: { read_at: null } }),
    ]);

    res.status(200).json({
      unread,
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        subject: n.subject,
        body: n.body,
        link: n.link,
        actor_id: n.actor_id,
        read_at: n.read_at,
        created_at: n.created_at,
      })),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications.list] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/notifications/:id/read
 *
 * updateMany, so somebody else's id matches zero rows and answers 404 rather
 * than confirming that it exists. The column-level grant means this statement
 * physically cannot touch anything but read_at.
 */
export async function markRead(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'id must be a uuid' });
    return;
  }

  try {
    const result = await req.tx.notifications.updateMany({
      where: { id: req.params.id, read_at: null },
      data: { read_at: new Date() },
    });

    if (result.count === 0) {
      // Already read, or not yours. Deliberately the same answer: telling a
      // caller which would confirm the existence of somebody else's row.
      res.status(404).json({ error: 'No unread notification of yours with that id' });
      return;
    }
    res.status(200).json({ id: req.params.id, read: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications.markRead] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** POST /api/notifications/read-all — clears the badge in one call. */
export async function markAllRead(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const result = await req.tx.notifications.updateMany({
      where: { read_at: null },
      data: { read_at: new Date() },
    });
    res.status(200).json({ read: result.count });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications.markAllRead] failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
