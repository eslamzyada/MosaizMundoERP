import { apiClient } from './client';
import type { MemberRepository } from './MemberRepository';
import type { Invitation, Member, Role } from '../types';

/**
 * Live implementation. Every mutation here is owner-only, enforced by the
 * database (0011 SECURITY DEFINER procedures) and answered as a 403/400 by the
 * API — the UI hiding a button is a courtesy, not the control.
 */
export class HttpMemberRepository implements MemberRepository {
  async getMembers(): Promise<Member[]> {
    const { data } = await apiClient.get<Member[]>('/api/members');
    return data;
  }

  async getInvitations(): Promise<Invitation[]> {
    const { data } = await apiClient.get<Invitation[]>('/api/members/invitations');
    return data;
  }

  async invite(email: string, role: Role): Promise<void> {
    await apiClient.post('/api/members/invite', { email, role });
  }

  async setRole(userId: string, role: Role): Promise<void> {
    await apiClient.patch(`/api/members/${userId}/role`, { role });
  }

  async setActive(userId: string, isActive: boolean): Promise<void> {
    await apiClient.patch(`/api/members/${userId}/active`, { is_active: isActive });
  }
}
