import { apiClient } from './client';
import type { RatingRepository } from './RatingRepository';
import type { RatingPayload, RatingsResponse } from '../types';

export class HttpRatingRepository implements RatingRepository {
  async list(month?: string): Promise<RatingsResponse> {
    const { data } = await apiClient.get<RatingsResponse>('/api/ratings', {
      params: month ? { month } : undefined,
    });
    return data;
  }

  async save(payload: RatingPayload): Promise<void> {
    // PUT, not POST: one rating per person per month, so this is a revision
    // rather than a second opinion.
    await apiClient.put('/api/ratings', payload);
  }
}
