import { apiClient } from './client';

/**
 * The room (0045).
 *
 * One request, joined in the database. Fetching tables, tabs and bookings
 * separately would mean joining three lists read at three different instants —
 * and showing a table as free because its tab arrived a moment later. On a
 * screen that refetches on every focus, that is a race somebody eventually
 * acts on.
 */

export interface FloorTab {
  id: string;
  opened_at: string;
  minutes_open: number;
  total_amount: number;
  item_count: number;
  /** Lines the kitchen has NOT been told about. The actionable number. */
  unfired_count: number;
  note: string | null;
}

export interface FloorReservation {
  id: string;
  guest_name: string;
  party_size: number;
  starts_at: string;
  minutes_until: number;
}

export interface FloorTable {
  id: string;
  label: string;
  area: string | null;
  seats: number | null;
  tab: FloorTab | null;
  next_reservation: FloorReservation | null;
}

export interface Floor {
  /**
   * NULL means this restaurant has no floor plan — it does not run the
   * reservations module. NOT the same as an empty room, and a screen that
   * renders "0 tables free" to a takeaway counter is telling it something
   * false about itself.
   */
  tables: FloorTable[] | null;
  unseated_tabs: FloorTab[];
  summary: {
    open_tabs: number;
    unseated_tabs: number;
    tables?: number;
    free?: number;
    occupied?: number;
    double_booked_soon?: number;
  };
}

export const floorRepository = {
  async get(): Promise<Floor> {
    const { data } = await apiClient.get<Floor>('/api/floor');
    return data;
  },
};
