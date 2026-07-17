import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import Badge from '../components/ui/Badge';
import Button from '../components/Button';
import InviteMemberModal from '../components/InviteMemberModal';
import { HttpMemberRepository } from '../api/HttpMemberRepository';
import type { MemberRepository } from '../api/MemberRepository';
import { ROLE_LABELS, useSession } from '../session/SessionProvider';
import { ROLES } from '../types';
import type { Invitation, Member, Role } from '../types';

const repository: MemberRepository = new HttpMemberRepository();

/** Surfaces the server's own message — the procedures word their refusals for humans. */
function serverMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = (err.response?.data as { error?: string } | undefined)?.error;
    if (msg) return msg;
  }
  return fallback;
}

export default function Members() {
  const { can, me } = useSession();
  const mayManage = can('manage_members');

  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    // A non-owner may read the roster but not invitations (owner-only data);
    // asking for both would hand them a spurious error.
    const memberData = await repository.getMembers();
    const inviteData = mayManage ? await repository.getInvitations() : [];
    return { memberData, inviteData };
  }, [mayManage]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    load()
      .then(({ memberData, inviteData }) => {
        setMembers(memberData);
        setInvitations(inviteData);
        setLoading(false);
      })
      .catch((err) => {
        setError(serverMessage(err, 'تعذّر تحميل الفريق. تأكّد من تشغيل الخادم.'));
        setLoading(false);
      });
  }, [load]);

  useEffect(() => {
    let active = true;
    load()
      .then(({ memberData, inviteData }) => {
        if (!active) return;
        setMembers(memberData);
        setInvitations(inviteData);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(serverMessage(err, 'تعذّر تحميل الفريق. تأكّد من تشغيل الخادم.'));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  async function changeRole(userId: string, role: Role) {
    setBusyUserId(userId);
    setActionError(null);
    try {
      await repository.setRole(userId, role);
      refresh();
    } catch (err) {
      setActionError(serverMessage(err, 'تعذّر تغيير الدور.'));
    } finally {
      setBusyUserId(null);
    }
  }

  async function toggleActive(member: Member) {
    setBusyUserId(member.user_id);
    setActionError(null);
    try {
      await repository.setActive(member.user_id, !member.is_active);
      refresh();
    } catch (err) {
      setActionError(serverMessage(err, 'تعذّر تحديث حالة العضو.'));
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-surface-dark">الفريق</h1>
          <p className="mt-1 text-sm text-slate-500">
            أعضاء المؤسسة وأدوارهم. الدور يحدّد ما يستطيع كل عضو فعله.
          </p>
        </div>
        {mayManage && (
          <Button variant="primary" onClick={() => setInviteOpen(true)} disabled={loading}>
            دعوة عضو
          </Button>
        )}
      </header>

      {/* Announced by screen readers without stealing focus. */}
      <div aria-live="polite" className="sr-only">
        {loading ? 'جارٍ تحميل الفريق' : `${members.length} عضو`}
      </div>

      {!mayManage && !loading && !error && (
        <p className="mb-4 rounded-xl border border-surface-sand-border bg-surface-sand-alt/60 px-4 py-3 text-xs text-slate-500">
          عرض فقط — إدارة الأعضاء متاحة للمالك.
        </p>
      )}

      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-destructive/30 bg-destructive-soft px-4 py-3 text-sm font-semibold text-destructive-strong"
        >
          {actionError}
        </div>
      )}

      <section className="mb-8">
        <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-surface-sand-border text-sm">
              <caption className="sr-only">أعضاء المؤسسة وأدوارهم وحالتهم</caption>
              <thead className="bg-surface-sand-alt/60">
                <tr>
                  <Th>البريد الإلكتروني</Th>
                  <Th>الدور</Th>
                  <Th>الحالة</Th>
                  <Th>
                    <span className="sr-only">إجراءات</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-sand-border/70">
                {error ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center">
                      <p className="mb-3 text-destructive-strong">{error}</p>
                      <Button variant="secondary" onClick={refresh}>
                        إعادة المحاولة
                      </Button>
                    </td>
                  </tr>
                ) : loading ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-slate-400">
                      جارٍ التحميل…
                    </td>
                  </tr>
                ) : members.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-slate-400">
                      لا يوجد أعضاء.
                    </td>
                  </tr>
                ) : (
                  members.map((m) => {
                    const isBusy = busyUserId === m.user_id;
                    // The server refuses self-service; don't offer it either.
                    const editable = mayManage && !m.is_self;
                    return (
                      <tr
                        key={m.user_id}
                        className={`transition-colors hover:bg-surface-sand/60 ${
                          m.is_active ? '' : 'opacity-60'
                        }`}
                      >
                        <td className="px-6 py-4 font-semibold text-surface-dark">
                          {m.email}
                          {m.is_self && (
                            <span className="ms-2 text-xs font-medium text-slate-400">(أنت)</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {editable ? (
                            <label className="block">
                              <span className="sr-only">{`دور ${m.email}`}</span>
                              <select
                                value={m.role}
                                disabled={isBusy}
                                onChange={(e) => changeRole(m.user_id, e.target.value as Role)}
                                className="rounded-lg border border-surface-sand-border bg-white px-2 py-1 text-sm text-surface-dark focus:border-twilight-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500/30 disabled:opacity-50"
                              >
                                {ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {ROLE_LABELS[r]}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <Badge variant={m.role === 'owner' ? 'twilight' : 'neutral'}>
                              {ROLE_LABELS[m.role]}
                            </Badge>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant={m.is_active ? 'success' : 'neutral'}>
                            {m.is_active ? 'نشط' : 'موقوف'}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-end">
                          {editable && (
                            <button
                              type="button"
                              onClick={() => toggleActive(m)}
                              disabled={isBusy}
                              className="rounded-lg px-2.5 py-1 text-xs font-bold text-twilight-700 transition-colors hover:bg-twilight-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-twilight-500 disabled:opacity-50"
                            >
                              {isBusy ? '…' : m.is_active ? 'إيقاف' : 'تفعيل'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {mayManage && (
        <section>
          <h2 className="mb-1 text-sm font-bold text-surface-dark">دعوات معلّقة</h2>
          <p className="mb-3 text-xs text-slate-500">
            ينضم المدعوّ إلى هذه المؤسسة تلقائيًا عند إنشاء حسابه.
          </p>
          <div className="overflow-hidden rounded-2xl border border-surface-sand-border bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-surface-sand-border text-sm">
                <caption className="sr-only">الدعوات المعلّقة</caption>
                <thead className="bg-surface-sand-alt/60">
                  <tr>
                    <Th>البريد الإلكتروني</Th>
                    <Th>الدور</Th>
                    <Th>تنتهي في</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-sand-border/70">
                  {loading ? (
                    <tr>
                      <td colSpan={3} className="px-6 py-8 text-center text-slate-400">
                        جارٍ التحميل…
                      </td>
                    </tr>
                  ) : invitations.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-6 py-8 text-center text-slate-400">
                        لا توجد دعوات معلّقة.
                      </td>
                    </tr>
                  ) : (
                    invitations.map((i) => (
                      <tr key={i.id} className="transition-colors hover:bg-surface-sand/60">
                        <td className="px-6 py-4 font-semibold text-surface-dark">{i.email}</td>
                        <td className="px-6 py-4">
                          <Badge variant="neutral">{ROLE_LABELS[i.role]}</Badge>
                        </td>
                        <td className="px-6 py-4 font-numerals text-slate-500">
                          {formatDate(i.expires_at)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <InviteMemberModal
        open={inviteOpen}
        currentUserRole={me?.role ?? null}
        onClose={() => setInviteOpen(false)}
        onInvite={async (email, role) => {
          await repository.invite(email, role);
          refresh();
        }}
      />
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="px-6 py-3.5 text-start text-xs font-bold uppercase tracking-wide text-slate-500"
    >
      {children}
    </th>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}
