import { apiClient } from './client';

/**
 * Cash-ups, and the pattern in them (0047).
 *
 * Every field here is the server's arithmetic. Nothing is recomputed on the
 * client, because the one number a cashier is held to must have exactly one
 * source.
 */

export interface TillSessionRow {
  id: string;
  opened_at: string;
  closed_at: string | null;
  opening_float: number;
  counted_cash: number | null;
  expected_cash: number | null;
  /** counted − expected. NEGATIVE is short; positive is over. */
  variance: number | null;
  closed_by: string | null;
  closed_by_email: string | null;
}

export interface TillPerson {
  closed_by: string | null;
  email: string | null;
  /** The denominator. A count without it points at whoever works most. */
  sessions: number;
  net: number;
  short_nights: number;
  over_nights: number;
  short_rate: number | null;
  worst_short: number;
}

export interface TillHistory {
  from: string;
  to: string;
  sessions: TillSessionRow[];
  people: TillPerson[];
  summary: {
    closed: number;
    balanced: number;
    out: number;
    net: number;
    /** Money that actually went missing, which `net` can mask. */
    total_short: number;
  };
}

export const tillRepository = {
  async history(from: Date, to: Date): Promise<TillHistory> {
    const { data } = await apiClient.get<TillHistory>('/api/till/sessions', {
      params: { from: from.toISOString(), to: to.toISOString() },
    });
    return data;
  },
};
