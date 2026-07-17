import type { Invitation, Member, Role } from '../types';

// The data-access boundary for the Members (team) context. The UI depends only
// on this interface.
export interface MemberRepository {
  /** The team roster for the caller's organization. Readable by any member. */
  getMembers(): Promise<Member[]>;

  /** Pending invitations (unaccepted and unexpired). */
  getInvitations(): Promise<Invitation[]>;

  /** Invites an email to join at a role. Owner-only (server-enforced). */
  invite(email: string, role: Role): Promise<void>;

  /** Changes a member's role. Owner-only; never your own row. */
  setRole(userId: string, role: Role): Promise<void>;

  /** Activates/deactivates a member. Owner-only; never your own row. */
  setActive(userId: string, isActive: boolean): Promise<void>;
}
