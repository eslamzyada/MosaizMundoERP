import { apiClient } from './client';

/**
 * The review rubric, and the scores against it (0033).
 *
 * Two resources with different audiences: the criteria are readable by every
 * member — a standard nobody may read is a standard nobody can meet — while the
 * scores are administrators only, following the same decision 0027 made for the
 * overall rating.
 */

export interface RatingCriterion {
  id: string;
  name: string;
  description: string | null;
  /** Relative importance in the reported average. Never rewrites the overall score. */
  weight: number;
  is_active: boolean;
  sort_order: number;
}

export interface CriterionScore {
  criterion_id: string;
  criterion_name: string;
  /** False for a retired criterion that still carries history. */
  criterion_is_active: boolean;
  weight: number;
  score: number;
  note: string | null;
}

export interface EmployeeCriterionScores {
  employee_id: string;
  scores: CriterionScore[];
  /** Computed by the SERVER, so two clients cannot derive it differently. */
  weighted_average: number | null;
}

export interface CriterionScoresResponse {
  month: string;
  /** False once the month has closed and nothing more can be written. */
  is_open: boolean;
  employees: EmployeeCriterionScores[];
}

export interface CriterionInput {
  name: string;
  description?: string | null;
  weight?: number;
  sort_order?: number;
}

export const ratingCriteriaRepository = {
  async list(includeRetired = false): Promise<RatingCriterion[]> {
    const { data } = await apiClient.get<RatingCriterion[]>('/api/rating-criteria', {
      params: includeRetired ? { include_retired: 'true' } : undefined,
    });
    return data;
  },

  async create(input: CriterionInput): Promise<RatingCriterion> {
    const { data } = await apiClient.post<RatingCriterion>('/api/rating-criteria', input);
    return data;
  },

  async update(id: string, patch: Partial<CriterionInput & { is_active: boolean }>): Promise<RatingCriterion> {
    const { data } = await apiClient.patch<RatingCriterion>(`/api/rating-criteria/${id}`, patch);
    return data;
  },

  /** Only ever succeeds for a criterion nobody has been scored against. */
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/api/rating-criteria/${id}`);
  },

  async scores(month?: string): Promise<CriterionScoresResponse> {
    const { data } = await apiClient.get<CriterionScoresResponse>('/api/rating-criteria/scores', {
      params: month ? { month } : undefined,
    });
    return data;
  },

  /**
   * Records one score. The month is the SERVER's to choose — only the current
   * one is writable, and letting a client name it would invite a request the
   * database is going to refuse anyway.
   */
  async score(employeeId: string, criterionId: string, score: number, note?: string): Promise<void> {
    await apiClient.put('/api/rating-criteria/scores', {
      employee_id: employeeId,
      criterion_id: criterionId,
      score,
      note,
    });
  },
};
