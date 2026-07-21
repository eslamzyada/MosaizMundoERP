import type { Stocktake, StocktakeSummary } from '../types';

/** One ingredient's counted quantity, as sent to the API. */
export interface StocktakeCount {
  raw_item_id: string;
  counted_quantity: number;
}

// Data-access boundary for counting the shelf. Everything except reading is
// admin-only, enforced by the API and the 0010 policies behind it.
export interface StocktakeRepository {
  list(): Promise<StocktakeSummary[]>;
  get(id: string): Promise<Stocktake>;
  /** Opens a draft covering every ingredient, pre-filled with the books. */
  start(): Promise<Stocktake>;
  /** Records what was actually on the shelf. Draft only. */
  saveCounts(id: string, counts: StocktakeCount[]): Promise<void>;
  /** Applies the variances so stock matches the count. */
  post(id: string): Promise<void>;
  /** Abandons a draft without touching stock. */
  cancel(id: string): Promise<void>;
}
