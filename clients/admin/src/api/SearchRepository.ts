import { apiClient } from './client';
import { routableHits } from '../lib/searchTargets';
import type { SearchHit } from '../lib/searchTargets';

/**
 * Below this, the server answers with nothing on purpose — every term matches
 * half the restaurant. Mirrors MIN_SEARCH_LENGTH in backend/src/lib/searchTerm.ts;
 * it lives here as well so the palette can say "keep typing" without a round
 * trip that was always going to come back empty.
 */
export const MIN_QUERY_LENGTH = 2;

/**
 * Asking the server what it has.
 *
 * `signal` is not optional decoration. This is called on a keystroke, and
 * without cancellation a slow answer to "طم" can land after a fast answer to
 * "طماطم" and replace it — the list would flicker back to results for a
 * question that is no longer on screen. The palette passes an AbortController
 * per request; axios turns an abort into a rejection the caller ignores.
 */
export const searchRepository = {
  async search(term: string, signal?: AbortSignal): Promise<SearchHit[]> {
    const { data } = await apiClient.get<{ results: SearchHit[] }>('/api/search', {
      params: { q: term },
      signal,
    });
    // A kind this build cannot route is dropped here, once, rather than
    // guarded at every place a hit is rendered.
    return routableHits(data.results ?? []);
  },
};
