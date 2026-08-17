import { logger } from '../lib/logger';
import { Request, Response } from 'express';
import { enabledModules } from '../lib/modules';
import { resolveMembership } from '../middleware/requireRole';

/**
 * The room.
 *
 * الصالة used to be a list of open ORDERS, each identified by whatever a server
 * had typed into its note. That answers "what is running" and nothing else —
 * and the question a manager actually walks in with is the opposite one:
 *
 *   what needs me now?
 *
 * Which is mostly about tables that are NOT in a list of orders. A table that
 * has been sitting twenty minutes with nothing ordered does not appear in a
 * list of tabs with items. Neither does a free table, and "how much of the room
 * is empty" is the other half of running a floor.
 *
 * ----------------------------------------------------------------------------
 * ONE REQUEST, JOINED IN THE DATABASE.
 *
 * The client could fetch tables, tabs and bookings and join them itself. It
 * would then be joining three lists fetched at three different instants, and
 * showing a table as free because its tab arrived a moment later. On a screen
 * that refreshes on every focus, that is a race somebody eventually acts on.
 *
 * ----------------------------------------------------------------------------
 * ABSENT, NOT EMPTY.
 *
 * A restaurant that does not run `reservations` has no floor plan at all —
 * `tables` is null, NOT an empty array. An empty room and no room are different
 * facts, and a screen that renders "0 tables free" to a takeaway counter is
 * telling it something false about itself. Same rule as the service report.
 */

interface FloorTab {
  id: string;
  opened_at: string;
  minutes_open: number;
  total_amount: number;
  item_count: number;
  /** Lines the kitchen has not been told about. The actionable number. */
  unfired_count: number;
  note: string | null;
}

/** Rounded to whole minutes; the floor does not care about seconds. */
const minutesSince = (d: Date) => Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
const minutesUntil = (d: Date) => Math.round((d.getTime() - Date.now()) / 60000);

/** GET /api/floor */
export async function getFloor(req: Request, res: Response): Promise<void> {
  if (!req.tx) {
    res.status(500).json({ error: 'No database transaction on request' });
    return;
  }

  try {
    const membership = await resolveMembership(req);
    if (!membership) {
      res.status(404).json({ error: 'No active organization membership found for this user' });
      return;
    }
    const modules = await enabledModules(req.tx, membership.organization_id);

    // Every open tab, with the lines needed to say what is wrong with it.
    // RLS-scoped through req.tx, so no organization filter appears here.
    const openTabs = await req.tx.orders.findMany({
      where: { status: 'open' },
      include: {
        order_items: { select: { quantity: true, fired_at: true } },
      },
      orderBy: { created_at: 'asc' },
    });

    const toTab = (o: (typeof openTabs)[number]): FloorTab => ({
      id: o.id,
      opened_at: o.created_at.toISOString(),
      minutes_open: minutesSince(o.created_at),
      total_amount: Number(o.total_amount),
      item_count: o.order_items.reduce((n, i) => n + i.quantity, 0),
      unfired_count: o.order_items
        .filter((i) => i.fired_at === null)
        .reduce((n, i) => n + i.quantity, 0),
      note: o.note,
    });

    // ---- Tabs with no table. Takeaway, delivery, and every tab in a
    //      restaurant that has no floor plan to sit them at. --------------
    const unseated = openTabs.filter((o) => o.table_id === null).map(toTab);

    // ---- The floor plan, when there is one. ---------------------------
    let tables: Array<Record<string, unknown>> | null = null;
    let summary: Record<string, unknown> = {
      open_tabs: openTabs.length,
      unseated_tabs: unseated.length,
    };

    if (modules.includes('reservations')) {
      const [plan, bookings] = await Promise.all([
        req.tx.restaurant_tables.findMany({
          where: { is_active: true },
          orderBy: [{ area: 'asc' }, { label: 'asc' }],
        }),
        // Only what is still coming. A booking already seated is the tab, and
        // one that has been and gone is history — neither needs a manager.
        req.tx.reservations.findMany({
          where: {
            status: 'booked',
            starts_at: { gte: new Date(Date.now() - 30 * 60000) },
          },
          orderBy: { starts_at: 'asc' },
        }),
      ]);

      const tabByTable = new Map(
        openTabs.filter((o) => o.table_id).map((o) => [o.table_id as string, o]),
      );
      const nextByTable = new Map<string, (typeof bookings)[number]>();
      for (const b of bookings) if (!nextByTable.has(b.table_id)) nextByTable.set(b.table_id, b);

      tables = plan.map((t) => {
        const tab = tabByTable.get(t.id);
        const next = nextByTable.get(t.id);

        return {
          id: t.id,
          label: t.label,
          area: t.area,
          seats: t.seats,
          tab: tab ? toTab(tab) : null,
          next_reservation: next
            ? {
                id: next.id,
                guest_name: next.guest_name,
                party_size: next.party_size,
                starts_at: next.starts_at.toISOString(),
                minutes_until: minutesUntil(next.starts_at),
              }
            : null,
        };
      });

      summary = {
        ...summary,
        tables: tables.length,
        free: tables.filter((t) => t.tab === null).length,
        occupied: tables.filter((t) => t.tab !== null).length,
        // A booking due within the hour on a table that is still occupied. The
        // one thing on this screen that is about to become somebody's problem
        // rather than already being one.
        double_booked_soon: tables.filter(
          (t) =>
            t.tab !== null &&
            t.next_reservation !== null &&
            (t.next_reservation as { minutes_until: number }).minutes_until <= 60,
        ).length,
      };
    }

    res.status(200).json({
      // Null means this restaurant has no floor plan, NOT that its room is
      // empty. A takeaway counter told "0 tables free" has been told something
      // false about itself.
      tables,
      unseated_tabs: unseated,
      summary,
    });
  } catch (err) {
    logger.error('floor failed', err, {
      request_id: req.requestId,
      user_id: req.userId,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
