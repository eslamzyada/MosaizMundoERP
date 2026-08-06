import { apiClient } from './client';

/**
 * The rota and the clock (0038).
 *
 * There is no "record an hour" call and there will not be one: `time_entries`
 * is read-only to the application role, and hours arrive only by clocking in
 * and out. A repository method that could write one would be a repository
 * method that could invent one.
 */

export interface Shift {
  id: string;
  organization_id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  note: string | null;
  created_by: string | null;
}

export interface ClockState {
  clocked_in: boolean;
  since: string | null;
  id: string | null;
}

export interface HoursRow {
  user_id: string;
  minutes: number;
  hours: number;
  entries: number;
  /**
   * NULL means UNKNOWN, never free (0042). Either nobody has recorded a rate,
   * or the caller may not read this person's pay — a branch manager gets hours
   * and no cost, by design.
   */
  cost: number | null;
  uncosted_entries: number;
}

export interface Wage {
  id: string;
  user_id: string;
  hourly_rate: number;
  effective_from: string;
  note: string | null;
  set_by: string | null;
}

export interface HoursReport {
  from: string;
  to: string;
  by_employee: HoursRow[];
  /** Only the part that could be costed; null when none of it could. */
  total_cost: number | null;
  uncosted_entries: number;
}

export const labourRepository = {
  async shifts(from: Date, to: Date): Promise<Shift[]> {
    const { data } = await apiClient.get<Shift[]>('/api/labour/shifts', {
      params: { from: from.toISOString(), to: to.toISOString() },
    });
    return data;
  },

  /** Rejects with 409 `shift_overlap` when that person is already working then. */
  async schedule(input: {
    user_id: string;
    starts_at: string;
    ends_at: string;
    note?: string;
  }): Promise<Shift> {
    const { data } = await apiClient.post<Shift>('/api/labour/shifts', input);
    return data;
  },

  async unschedule(id: string): Promise<void> {
    await apiClient.delete(`/api/labour/shifts/${id}`);
  },

  async clock(): Promise<ClockState> {
    const { data } = await apiClient.get<ClockState>('/api/labour/clock');
    return data;
  },

  async clockIn(shiftId?: string): Promise<void> {
    await apiClient.post('/api/labour/clock-in', shiftId ? { shift_id: shiftId } : {});
  },

  /** Returns the minutes the server recorded — never a number this client computed. */
  async clockOut(): Promise<number> {
    const { data } = await apiClient.post<{ minutes: number }>('/api/labour/clock-out');
    return data.minutes;
  },

  async wages(userId?: string): Promise<Wage[]> {
    const { data } = await apiClient.get<Wage[]>('/api/labour/wages', {
      params: userId ? { user_id: userId } : undefined,
    });
    return data;
  },

  /**
   * A raise is a NEW ROW from a date — there is no update, because editing one
   * would rewrite what somebody was owed last month.
   *
   * effectiveFrom is a YYYY-MM-DD STRING. Sending a Date would serialise to
   * UTC and land on the previous day east of UTC.
   */
  async setWage(input: {
    user_id: string;
    hourly_rate: number;
    effective_from: string;
    note?: string;
  }): Promise<void> {
    await apiClient.post('/api/labour/wages', input);
  },

  async hours(from: Date, to: Date): Promise<HoursReport> {
    const { data } = await apiClient.get<HoursReport>('/api/labour/hours', {
      params: { from: from.toISOString(), to: to.toISOString() },
    });
    return data;
  },
};
