import { apiClient } from './client';

/**
 * Which parts of the system this restaurant runs (0037).
 *
 * Reading is open to every member; writing is refused by the database for
 * anybody but an owner or a regional manager, so this repository has no role
 * check of its own — one would only ever disagree with the real one.
 */

export interface TenantModule {
  key: string;
  name: string;
  description: string;
  depends_on: string[];
  /** 'database' or 'application' — where the gate for this one actually is. */
  enforced_in: string;
  enabled: boolean;
  /** The cheapest plan that may switch this on (0044). */
  min_plan: PlanTier;
  /** Whether this restaurant's plan reaches it. Separate from `enabled`. */
  entitled: boolean;
  /** Kept from before plans existed, so the ceiling lets it through anyway. */
  grandfathered: boolean;
}

export type PlanTier = 'basic' | 'standard' | 'premium' | 'enterprise';

/** What each tier is called on screen. */
export const PLAN_NAMES: Record<PlanTier, string> = {
  basic: 'الأساسية',
  standard: 'القياسية',
  premium: 'المتقدّمة',
  enterprise: 'المؤسسات',
};

export const planName = (p: string): string => PLAN_NAMES[p as PlanTier] ?? p;

export const moduleRepository = {
  async list(): Promise<TenantModule[]> {
    const { data } = await apiClient.get<TenantModule[]>('/api/modules');
    return data;
  },

  /**
   * Rejects with a 409 carrying `blocked_by` when the change would leave the
   * system in a shape that cannot work, or a 402 carrying `required_plan` when
   * the restaurant's plan does not reach it. Those are different problems with
   * different fixes and the caller has to tell them apart.
   */
  async set(key: string, enabled: boolean): Promise<void> {
    await apiClient.put(`/api/modules/${key}`, { enabled });
  },
};
