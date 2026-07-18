import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiClient } from '../api/client';
import type { Me, Role } from '../types';

/**
 * What the signed-in user may do. These lists MIRROR the database — they are not
 * the enforcement point. Migration 0010's RESTRICTIVE policies decide, and the
 * API answers 403; this only decides which affordances to render, so a user is
 * never invited to click something that will be refused.
 *
 * Keep in step with app.user_can_administer / app.user_can_sell /
 * app.caller_may_manage_members.
 */
const ADMINISTER: Role[] = ['owner', 'regional_manager', 'branch_manager'];
const SELL: Role[] = [...ADMINISTER, 'cashier', 'staff'];
const MANAGE_MEMBERS: Role[] = ['owner'];

export type Capability = 'administer' | 'sell' | 'manage_members';

const CAPABILITY_ROLES: Record<Capability, Role[]> = {
  administer: ADMINISTER,
  sell: SELL,
  manage_members: MANAGE_MEMBERS,
};

interface SessionValue {
  me: Me | null;
  loading: boolean;
  /** True when /api/me could not be resolved (network, 401, or no membership). */
  error: boolean;
  reload: () => void;
  can: (capability: Capability) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Resolves GET /api/me ONCE for the whole app and shares it. Pages previously
 * had no way to know the caller's role at all; fetching it per page would also
 * mean a request waterfall on every navigation.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);

    apiClient
      .get<Me>('/api/me')
      .then(({ data }) => {
        if (!active) return;
        setMe(data);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setMe(null);
        setError(true);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [nonce]);

  const value = useMemo<SessionValue>(
    () => ({
      me,
      loading,
      error,
      reload,
      // Unknown role -> no affordances. Fail closed in the UI too.
      can: (capability) => (me ? CAPABILITY_ROLES[capability].includes(me.role) : false),
    }),
    [me, loading, error, reload],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return ctx;
}

/** Human-readable role names for the UI (Arabic-first, like the rest of the admin). */
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'مالك',
  regional_manager: 'مدير إقليمي',
  branch_manager: 'مدير فرع',
  accountant: 'محاسب',
  cashier: 'كاشير',
  staff: 'موظف',
};
