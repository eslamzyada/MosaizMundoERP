import { apiClient } from './client';

/**
 * The menu approval cycle (0035).
 *
 * There is no "save the menu" call here, because there is no such thing any
 * more: the application role has no INSERT or UPDATE on sellable_items. A
 * change is proposed, and somebody else decides it.
 */

export type MenuChangeKind = 'create' | 'update' | 'retire';
export type MenuChangeStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface MenuChangeSnapshot {
  name: string | null;
  sku: string | null;
  price: number | null;
}

export interface MenuChange {
  id: string;
  kind: MenuChangeKind;
  status: MenuChangeStatus;
  sellable_item_id: string | null;
  /** The dish as it stands today, so the queue can show a real before/after. */
  current: MenuChangeSnapshot | null;
  proposed: MenuChangeSnapshot;
  reason: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

export interface ProposeInput {
  kind: MenuChangeKind;
  sellable_item_id?: string | null;
  name?: string | null;
  sku?: string | null;
  price?: number | null;
  /** Required by the server: a queue of unexplained changes is one nobody reads. */
  reason: string;
}

export const menuChangeRepository = {
  async list(status?: MenuChangeStatus): Promise<MenuChange[]> {
    const { data } = await apiClient.get<MenuChange[]>('/api/menu-changes', {
      params: status ? { status } : undefined,
    });
    return data;
  },

  async propose(input: ProposeInput): Promise<{ id: string; status: MenuChangeStatus }> {
    const { data } = await apiClient.post('/api/menu-changes', input);
    return data;
  },

  async decide(id: string, approve: boolean, note?: string): Promise<void> {
    await apiClient.post(`/api/menu-changes/${id}/decide`, { approve, note });
  },

  /** Taking back your own proposal. Somebody else's answers 404. */
  async withdraw(id: string): Promise<void> {
    await apiClient.post(`/api/menu-changes/${id}/withdraw`);
  },
};
