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
}

export const moduleRepository = {
  async list(): Promise<TenantModule[]> {
    const { data } = await apiClient.get<TenantModule[]>('/api/modules');
    return data;
  },

  /**
   * Rejects with a 409 carrying `blocked_by` when the change would leave the
   * system in a shape that cannot work.
   */
  async set(key: string, enabled: boolean): Promise<void> {
    await apiClient.put(`/api/modules/${key}`, { enabled });
  },
};
