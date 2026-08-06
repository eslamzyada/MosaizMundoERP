import { apiClient } from './client';

/**
 * Tables and bookings (0039).
 *
 * `isFree` asks the SERVER, which asks the same predicate the EXCLUDE
 * constraint uses. Computing availability in this client would be a second
 * opinion, and the day the two disagree is the day a host promises a table
 * that the database then refuses — with a guest standing in the doorway.
 */

export type ReservationStatus = 'booked' | 'seated' | 'completed' | 'no_show' | 'cancelled';

export interface RestaurantTable {
  id: string;
  label: string;
  area: string | null;
  seats: number;
  is_active: boolean;
}

export interface Reservation {
  id: string;
  table_id: string;
  guest_name: string;
  guest_phone: string | null;
  party_size: number;
  starts_at: string;
  ends_at: string;
  status: ReservationStatus;
  note: string | null;
}

export const reservationRepository = {
  async tables(includeRetired = false): Promise<RestaurantTable[]> {
    const { data } = await apiClient.get<RestaurantTable[]>('/api/reservations/tables', {
      params: includeRetired ? { all: 'true' } : undefined,
    });
    return data;
  },

  async createTable(input: { label: string; area?: string; seats: number }): Promise<RestaurantTable> {
    const { data } = await apiClient.post<RestaurantTable>('/api/reservations/tables', input);
    return data;
  },

  /** Retiring, not deleting — a table that has held bookings explains them. */
  async retireTable(id: string): Promise<void> {
    await apiClient.patch(`/api/reservations/tables/${id}`, { is_active: false });
  },

  async list(from: Date, to: Date): Promise<Reservation[]> {
    const { data } = await apiClient.get<Reservation[]>('/api/reservations', {
      params: { from: from.toISOString(), to: to.toISOString() },
    });
    return data;
  },

  async isFree(tableId: string, startsAt: string, endsAt: string): Promise<boolean> {
    const { data } = await apiClient.get<{ free: boolean }>('/api/reservations/availability', {
      params: { table_id: tableId, starts_at: startsAt, ends_at: endsAt },
    });
    return data.free;
  },

  /** Rejects with 409 `double_booking` when the table is already promised. */
  async book(input: {
    table_id: string;
    guest_name: string;
    guest_phone?: string;
    party_size: number;
    starts_at: string;
    ends_at: string;
    note?: string;
  }): Promise<Reservation> {
    const { data } = await apiClient.post<Reservation>('/api/reservations', input);
    return data;
  },

  async setStatus(id: string, status: ReservationStatus): Promise<void> {
    await apiClient.post(`/api/reservations/${id}/status`, { status });
  },
};
