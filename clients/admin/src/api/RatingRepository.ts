import type { RatingPayload, RatingsResponse } from '../types';

/**
 * Employee ratings (0027) — a manager's judgement, kept apart from the measured
 * figures. The API restricts these to administrators AND the database gates
 * reads, so a cashier sees nothing here even if the UI forgot to hide it.
 */
export interface RatingRepository {
  /** Ratings for one month, or the latest per employee when month is omitted. */
  list(month?: string): Promise<RatingsResponse>;
  /** Records or revises the rating for one employee and month. */
  save(payload: RatingPayload): Promise<void>;
}
