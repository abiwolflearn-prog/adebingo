import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bell,
  Bot,
  CheckCircle2,
  CreditCard,
  DollarSign,
  Gamepad2,
  Lock,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Users,
  UserX,
} from 'lucide-react';
import type { Language } from '../types/bingo';
import type {
  AdminAuditRecord,
  AdminDepositRequest,
  AdminManagedUserRecord,
  AdminPayoutOrder,
  AdminReferralRecord,
  AdminRoomConfigRecord,
  DepositRequestStatus,
  PayoutOrderStatus,
  VerifiedSessionActor,
} from '../utils/adminAuthority';
import type { BotAdminConfig, BotNotificationMessage } from '../utils/telegramBot';

interface AdminDashboardScreenProps {
  lang: Language;
  onToggleLang: () => void;
  onReturnToPlayerApp: () => void;
}

type AdminSectionId =
  | 'overview'
  | 'users'
  | 'payouts'
  | 'deposits'
  | 'rooms'
  | 'referrals'
  | 'bot'
  | 'notifications'
  | 'settings';

const PAYOUT_STATUSES: PayoutOrderStatus[] = [
  'Pending',
  'Under Review',
  'Approved',
  'Rejected',
  'Completed',
];

const DEPOSIT_STATUSES: DepositRequestStatus[] = ['Pending', 'Approved', 'Rejected'];

export const AdminDashboardScreen: React.FC<AdminDashboardScreenProps> = ({
  lang,
  onToggleLang,
  onReturnToPlayerApp,
}) => {
  const [sessionMode, setSessionMode] = useState<'admin' | 'player' | 'unauthenticated'>('admin');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [authStatus, setAuthStatus] = useState<{
    loading: boolean;
    authorized: boolean;
    statusCode: number;
    reason: string;
    message: string;
    actor: VerifiedSessionActor | null;
  }>({
    loading: true,
    authorized: false,
    statusCode: 0,
    reason: 'initializing',
    message: '',
    actor: null,
  });

  const [activeTab, setActiveTab] = useState<AdminSectionId>('overview');
  const [bannerMsg, setBannerMsg] = useState<string>('');
  const [escalationTestResult, setEscalationTestResult] = useState<string>('');

  // Section states fetched strictly from server-protected /api/admin/* endpoints
  const [overview, setOverview] = useState<{
    totalUsers: number;
    activeUsers: number;
    suspendedUsers: number;
    verifiedPhoneUsers: number;
    payoutCounts: Record<string, number>;
    depositCounts: Record<string, number>;
    activeRoomsCount: number;
    totalOnlinePlayers: number;
    totalReferrals: number;
    botStats: {
      totalUpdatesProcessed: number;
      callbacksHandled: number;
      duplicateCallbacksBlocked: number;
      announcementsSent: number;
    };
    auditTrailEntries: number;
    auditIntegrity: { valid: boolean; totalEntries: number };
  } | null>(null);

  const [users, setUsers] = useState<AdminManagedUserRecord[]>([]);
  const [userSearchQuery, setUserSearchQuery] = useState<string>('');
  const [selectedUser, setSelectedUser] = useState<AdminManagedUserRecord | null>(null);
  const [statusReasonInput, setStatusReasonInput] = useState<string>(
    'Policy compliance review by administrator'
  );

  const [payouts, setPayouts] = useState<AdminPayoutOrder[]>([]);
  const [payoutFilter, setPayoutFilter] = useState<string>('ALL');
  const [payoutNotesById, setPayoutNotesById] = useState<Record<string, string>>({});

  const [deposits, setDeposits] = useState<AdminDepositRequest[]>([]);
  const [depositNotesById, setDepositNotesById] = useState<Record<string, string>>({});

  const [rooms, setRooms] = useState<AdminRoomConfigRecord[]>([]);
  const [referrals, setReferrals] = useState<AdminReferralRecord[]>([]);
  const [botConfig, setBotConfig] = useState<BotAdminConfig | null>(null);
  const [welcomeAmDraft, setWelcomeAmDraft] = useState<string>('');
  const [welcomeEnDraft, setWelcomeEnDraft] = useState<string>('');
  const [miniAppUrlDraft, setMiniAppUrlDraft] = useState<string>('');
  const [playLabelAmDraft, setPlayLabelAmDraft] = useState<string>('');
  const [playLabelEnDraft, setPlayLabelEnDraft] = useState<string>('');
  const [announceTitleAm, setAnnounceTitleAm] = useState<string>('📢 ልዩ የADEYBINGO የሙከራ ውድድር!');
  const [announceTitleEn, setAnnounceTitleEn] = useState<string>('📢 Special ADEYBINGO Demo Tournament!');
  const [announceBodyAm, setAnnounceBodyAm] = useState<string>(
    'ዛሬ ምሽት በአደይ ዋና አዳራሽ ልዩ የቢንጎ ዙር ይካሄዳል። ካርድዎን አሁኑኑ ይምረጡ!'
  );
  const [announceBodyEn, setAnnounceBodyEn] = useState<string>(
    'Join Adey Main Hall tonight for our featured Demo Bingo round. Reserve up to 4 cards now!'
  );

  const [notificationsOutbox, setNotificationsOutbox] = useState<BotNotificationMessage[]>([]);
  const [adminSettings, setAdminSettings] = useState<{
    authorizedAdminTelegramIds: number[];
    authorizedAdminEmails: string[];
    securityPolicies: Record<string, unknown>;
    auditChainIntegrity: { valid: boolean; totalEntries: number };
    auditTrail: AdminAuditRecord[];
  } | null>(null);

  useEffect(() => {
    void switchServerSession('admin');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchServerSession(mode: 'admin' | 'player' | 'unauthenticated') {
    setSessionMode(mode);
    setEscalationTestResult('');
    setAuthStatus((prev) => ({ ...prev, loading: true }));

    if (mode === 'unauthenticated') {
      setSessionToken('');
      const checkResp = await fetch('/api/admin/session');
      const checkData = await checkResp.json();
      setAuthStatus({
        loading: false,
        authorized: false,
        statusCode: checkResp.status,
        reason: checkData.reason || 'unauthenticated',
        message: checkData.message || 'HTTP 401 Unauthorized',
        actor: null,
      });
      return;
    }

    try {
      const exResp = await fetch('/api/admin/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityMode: mode }),
      });
      const exData = await exResp.json();
      const token = exData.token || '';
      setSessionToken(token);

      const verifyResp = await fetch('/api/admin/session', {
        headers: { 'x-adey-session-token': token },
      });
      const verifyData = await verifyResp.json();

      if (verifyResp.ok && verifyData.authorized) {
        setAuthStatus({
          loading: false,
          authorized: true,
          statusCode: verifyResp.status,
          reason: 'authorized_admin',
          message: 'Server-Verified Administrator Session Active',
          actor: verifyData.actor,
        });
        await loadAllAdminData(token);
      } else {
        setAuthStatus({
          loading: false,
          authorized: false,
          statusCode: verifyResp.status,
          reason: verifyData.reason || 'forbidden_not_admin',
          message:
            verifyData.message ||
            'HTTP 403 Forbidden: Normal players cannot access the administrator dashboard.',
          actor: verifyData.actor || exData.actor || null,
        });
      }
    } catch (err) {
      setAuthStatus({
        loading: false,
        authorized: false,
        statusCode: 500,
        reason: 'network_error',
        message: err instanceof Error ? err.message : 'Failed to verify admin session',
        actor: null,
      });
    }
  }

  async function handleTestSelfRoleEscalation() {
    try {
      const resp = await fetch('/api/admin/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identityMode: 'player',
          requestedRole: 'admin',
        }),
      });
      const data = await resp.json();
      setEscalationTestResult(
        `Server HTTP ${resp.status}: ${data.reason} — Audit #${data.auditRecord?.sequence || 1} (${String(
          data.auditRecord?.entryHash || ''
        ).slice(0, 14)}...)`
      );
    } catch {
      setEscalationTestResult('Role escalation test failed');
    }
  }

  async function loadAllAdminData(tokenOverride?: string) {
    const tkn = tokenOverride ?? sessionToken;
    if (!tkn) return;
    const headers = { 'x-adey-session-token': tkn };

    const [ovR, usR, poR, dpR, rmR, rfR, btR, ntR, stR] = await Promise.all([
      fetch('/api/admin/overview', { headers }),
      fetch(`/api/admin/users?q=${encodeURIComponent(userSearchQuery)}`, { headers }),
      fetch(`/api/admin/payouts?status=${encodeURIComponent(payoutFilter)}`, { headers }),
      fetch('/api/admin/deposits', { headers }),
      fetch('/api/admin/rooms', { headers }),
      fetch('/api/admin/referrals', { headers }),
      fetch('/api/admin/bot/config', { headers }),
      fetch('/api/admin/notifications', { headers }),
      fetch('/api/admin/settings', { headers }),
    ]);

    if (ovR.ok) {
      const d = await ovR.json();
      setOverview(d.overview);
    }
    if (usR.ok) {
      const d = await usR.json();
      setUsers(d.users || []);
      if (!selectedUser && d.users?.length > 0) {
        setSelectedUser(d.users[0]);
      } else if (selectedUser) {
        const refreshed = (d.users || []).find(
          (u: AdminManagedUserRecord) => u.uid === selectedUser.uid
        );
        if (refreshed) setSelectedUser(refreshed);
      }
    }
    if (poR.ok) {
      const d = await poR.json();
      setPayouts(d.payouts || []);
    }
    if (dpR.ok) {
      const d = await dpR.json();
      setDeposits(d.deposits || []);
    }
    if (rmR.ok) {
      const d = await rmR.json();
      setRooms(d.rooms || []);
    }
    if (rfR.ok) {
      const d = await rfR.json();
      setReferrals(d.referrals || []);
    }
    if (btR.ok) {
      const d = await btR.json();
      const cfg: BotAdminConfig = d.botConfig;
      setBotConfig(cfg);
      setWelcomeAmDraft(cfg.customWelcomeAm || '');
      setWelcomeEnDraft(cfg.customWelcomeEn || '');
      setMiniAppUrlDraft(cfg.miniAppUrl || '');
      setPlayLabelAmDraft(cfg.buttonLabels.playBingoAm || '');
      setPlayLabelEnDraft(cfg.buttonLabels.playBingoEn || '');
    }
    if (ntR.ok) {
      const d = await ntR.json();
      setNotificationsOutbox(d.outbox || []);
    }
    if (stR.ok) {
      const d = await stR.json();
      setAdminSettings(d.settings || null);
    }
  }

  async function handleSearchUsers(query: string) {
    setUserSearchQuery(query);
    if (!sessionToken) return;
    const resp = await fetch(`/api/admin/users?q=${encodeURIComponent(query)}`, {
      headers: { 'x-adey-session-token': sessionToken },
    });
    if (resp.ok) {
      const data = await resp.json();
      setUsers(data.users || []);
    }
  }

  async function handleToggleUserStatus(target: AdminManagedUserRecord) {
    if (!sessionToken) return;
    const nextStatus = target.accountStatus === 'active' ? 'suspended' : 'active';
    const resp = await fetch(`/api/admin/users/${encodeURIComponent(target.uid)}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-adey-session-token': sessionToken,
      },
      body: JSON.stringify({
        accountStatus: nextStatus,
        reason: statusReasonInput,
      }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      setBannerMsg(
        `✓ User ${target.displayName} (${target.uid}) status updated to ${nextStatus.toUpperCase()} · Audit #${data.auditRecord?.sequence}`
      );
      await loadAllAdminData();
    }
  }

  async function handleReviewPayout(requestId: string, nextStatus: PayoutOrderStatus) {
    if (!sessionToken) return;
    const notes =
      payoutNotesById[requestId] ||
      `Admin reviewed & set status to ${nextStatus} (Demo Sandbox)`;
    const resp = await fetch(`/api/admin/payouts/${encodeURIComponent(requestId)}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-adey-session-token': sessionToken,
      },
      body: JSON.stringify({
        nextStatus,
        reviewNotes: notes,
      }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      setBannerMsg(
        `✓ Payout Order ${requestId} updated to "${nextStatus}" · Immutable Audit #${data.auditRecord?.sequence}`
      );
      await loadAllAdminData();
    }
  }

  async function handleReviewDeposit(depositId: string, nextStatus: DepositRequestStatus) {
    if (!sessionToken) return;
    const notes =
      depositNotesById[depositId] || `Demo deposit marked ${nextStatus} by administrator`;
    const resp = await fetch(`/api/admin/deposits/${encodeURIComponent(depositId)}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-adey-session-token': sessionToken,
      },
      body: JSON.stringify({
        nextStatus,
        reviewNotes: notes,
      }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      setBannerMsg(
        `✓ Deposit Request ${depositId} updated to "${nextStatus}" · Audit #${data.auditRecord?.sequence}`
      );
      await loadAllAdminData();
    }
  }

  async function handleUpdateRoom(
    roomId: string,
    patch: {
      cardPriceEtb?: number;
      lobbyCountdownSeconds?: number;
      minPlayers?: number;
      status?: AdminRoomConfigRecord['status'];
    }
  ) {
    if (!sessionToken) return;
    const resp = await fetch(`/api/admin/rooms/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-adey-session-token': sessionToken,
      },
      body: JSON.stringify(patch),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      setBannerMsg(`✓ Room ${roomId} updated · Audit #${data.auditRecord?.sequence}`);
      await loadAllAdminData();
    }
  }

  async function handleSaveBotConfig() {
    if (!sessionToken) return;
    const resp = await fetch('/api/admin/bot/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-adey-session-token': sessionToken,
      },
      body: JSON.stringify({
        miniAppUrl: miniAppUrlDraft,
        customWelcomeAm: welcomeAmDraft.trim() || null,
        customWelcomeEn: welcomeEnDraft.trim() || null,
        buttonLabels: {
          playBingoAm: playLabelAmDraft,
          playBingoEn: playLabelEnDraft,
        },
      }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      setBannerMsg(
        `✓ Telegram Bot configuration saved on server · Audit #${data.auditRecord?.sequence}`
      );
      await loadAllAdminData();
    }
  }

  async function handleSendAnnouncement() {
    if (!sessionToken) return;
    const resp = await fetch('/api/admin/bot/announce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-adey-session-token': sessionToken,
      },
      body: JSON.stringify({
        titleAm: announceTitleAm,
        titleEn: announceTitleEn,
        bodyAm: announceBodyAm,
        bodyEn: announceBodyEn,
        targetAudience: 'all_players',
      }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      setBannerMsg(
        `✓ Bot Announcement dispatched to ${data.announcement?.recipientCount} player(s) · Audit #${data.auditRecord?.sequence}`
      );
      await loadAllAdminData();
    }
  }

  const navItems: { id: AdminSectionId; labelEn: string; labelAm: string; icon: React.ReactNode }[] =
    [
      { id: 'overview', labelEn: 'Overview', labelAm: 'አጠቃላይ እይታ', icon: <Activity size={15} /> },
      { id: 'users', labelEn: 'User Management', labelAm: 'ተጫዋቾች', icon: <Users size={15} /> },
      {
        id: 'payouts',
        labelEn: 'Payout Orders (Demo)',
        labelAm: 'የወጪ ጥያቄዎች',
        icon: <DollarSign size={15} />,
      },
      {
        id: 'deposits',
        labelEn: 'Deposit Requests',
        labelAm: 'የተቀማጭ ጥያቄዎች',
        icon: <CreditCard size={15} />,
      },
      { id: 'rooms', labelEn: 'Game Rooms', labelAm: 'የጨዋታ ክፍሎች', icon: <Gamepad2 size={15} /> },
      { id: 'referrals', labelEn: 'Referrals', labelAm: 'ግብዣዎች', icon: <Users size={15} /> },
      { id: 'bot', labelEn: 'Bot Management', labelAm: 'የቦት አስተዳደር', icon: <Bot size={15} /> },
      { id: 'notifications', labelEn: 'Notifications', labelAm: 'ማሳወቂያዎች', icon: <Bell size={15} /> },
      {
        id: 'settings',
        labelEn: 'Admin Settings & Audit',
        labelAm: 'ደህንነት እና ኦዲት',
        icon: <Settings size={15} />,
      },
    ];

  return (
    <div className="min-h-screen bg-[#f4faf6] text-[#153525] p-3 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Top Admin Bar + Role Verification Switcher */}
        <header className="bg-[#112d1f] text-white rounded-2xl p-4 shadow-md flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#12ad68] text-white font-['Outfit'] font-black text-lg grid place-items-center">
              A
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-['Outfit'] text-lg font-extrabold tracking-tight m-0">
                  ADEYBINGO · ADMIN CONSOLE
                </h1>
                <span className="px-2 py-0.5 rounded-md bg-[#eab308] text-[#422006] text-[10px] font-black uppercase">
                  /admin · DEMO SANDBOX
                </span>
              </div>
              <p className="text-xs text-[#9ce0be] m-0">
                {lang === 'am'
                  ? 'በሰርቨር የተረጋገጠ የአስተዳዳሪ ዳሽቦርድ (Server-Side Role Authorization)'
                  : 'Server-Verified Role-Based Administrator Dashboard · Real-Money Disabled'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Live Server Role Test Switcher */}
            <div
              className="flex items-center gap-1 bg-white/10 p-1 rounded-xl border border-white/15"
              data-testid="admin-role-switcher"
            >
              <button
                type="button"
                data-testid="switch-role-admin"
                onClick={() => switchServerSession('admin')}
                className={`px-2.5 py-1 rounded-lg text-xs font-extrabold transition-colors ${
                  sessionMode === 'admin'
                    ? 'bg-[#12ad68] text-white'
                    : 'text-[#cdeee0] hover:bg-white/10'
                }`}
              >
                Admin (200)
              </button>
              <button
                type="button"
                data-testid="switch-role-player"
                onClick={() => switchServerSession('player')}
                className={`px-2.5 py-1 rounded-lg text-xs font-extrabold transition-colors ${
                  sessionMode === 'player'
                    ? 'bg-amber-500 text-slate-950'
                    : 'text-[#cdeee0] hover:bg-white/10'
                }`}
              >
                Normal Player (403)
              </button>
              <button
                type="button"
                data-testid="switch-role-unauth"
                onClick={() => switchServerSession('unauthenticated')}
                className={`px-2.5 py-1 rounded-lg text-xs font-extrabold transition-colors ${
                  sessionMode === 'unauthenticated'
                    ? 'bg-red-500 text-white'
                    : 'text-[#cdeee0] hover:bg-white/10'
                }`}
              >
                Unauthenticated (401)
              </button>
            </div>

            <button
              type="button"
              onClick={onToggleLang}
              className="px-3 py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-extrabold text-white"
            >
              {lang === 'am' ? '🌐 አማ / EN' : '🌐 EN / አማ'}
            </button>

            <button
              type="button"
              data-testid="return-player-app-btn"
              onClick={onReturnToPlayerApp}
              className="px-3.5 py-1.5 rounded-xl bg-white text-[#112d1f] text-xs font-extrabold flex items-center gap-1.5 hover:bg-[#e6f5ec]"
            >
              <ArrowLeft size={14} />
              {lang === 'am' ? 'ወደ ተጫዋች መተግበሪያ (/)' : 'Player App (/)'}
            </button>
          </div>
        </header>

        {/* Server-Side Access Denied Screen when Normal Player (403) or Unauthenticated (401) */}
        {!authStatus.authorized ? (
          <div
            data-testid="admin-access-denied"
            className="bg-white border-2 border-red-200 rounded-2xl p-6 sm:p-8 shadow-sm max-w-2xl mx-auto text-center space-y-4 my-8"
          >
            <div className="w-14 h-14 rounded-2xl bg-red-50 text-red-600 grid place-items-center mx-auto">
              <Lock size={28} />
            </div>
            <span className="inline-block px-3 py-1 rounded-full bg-red-100 text-red-800 font-mono text-xs font-extrabold">
              HTTP {authStatus.statusCode || 403} · {authStatus.reason.toUpperCase()}
            </span>
            <h2 className="font-['Outfit'] text-2xl font-extrabold text-[#193b2b]">
              {authStatus.statusCode === 401
                ? lang === 'am'
                  ? 'ማረጋገጫ ያስፈልጋል (HTTP 401 Unauthorized)'
                  : 'Authentication Required (HTTP 401 Unauthorized)'
                : lang === 'am'
                ? 'የአስተዳዳሪ ፈቃድ የለዎትም (HTTP 403 Forbidden)'
                : 'Administrator Access Denied (HTTP 403 Forbidden)'}
            </h2>
            <p className="text-sm text-[#4a6656] max-w-lg mx-auto">
              {authStatus.message}
            </p>
            {authStatus.actor && (
              <div className="p-3 rounded-xl bg-[#f7fbf8] border border-[#dcece1] text-xs font-mono text-[#335443]">
                Current Verified Identity: <b>{authStatus.actor.displayName}</b> (
                <code>{authStatus.actor.uid}</code>) · Server Role:{' '}
                <b className="text-red-700 uppercase">{authStatus.actor.role}</b>
              </div>
            )}

            <div className="pt-2 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                data-testid="test-self-role-escalation-btn"
                onClick={handleTestSelfRoleEscalation}
                className="px-4 py-2.5 rounded-xl bg-amber-100 border border-amber-300 text-amber-950 text-xs font-extrabold hover:bg-amber-200"
              >
                🚫 Test Self-Role Escalation Attack (Expect 403)
              </button>
              <button
                type="button"
                onClick={() => switchServerSession('admin')}
                className="px-4 py-2.5 rounded-xl bg-[#087e50] text-white text-xs font-extrabold hover:brightness-105"
              >
                ✓ Switch to Verified Admin Session (TG #8842109)
              </button>
              <button
                type="button"
                onClick={onReturnToPlayerApp}
                className="px-4 py-2.5 rounded-xl bg-[#edf5f0] text-[#193b2b] text-xs font-extrabold"
              >
                Return to Player UI (/)
              </button>
            </div>

            {escalationTestResult && (
              <div
                data-testid="escalation-test-result"
                className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-900 font-mono text-xs font-bold"
              >
                {escalationTestResult}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Status Toast Banner */}
            {bannerMsg && (
              <div
                data-testid="admin-action-banner"
                className="bg-[#e7f8ed] border border-[#8ce0b3] text-[#065f3c] px-4 py-3 rounded-xl text-xs font-extrabold flex items-center justify-between"
              >
                <span>{bannerMsg}</span>
                <button
                  type="button"
                  onClick={() => setBannerMsg('')}
                  className="text-xs font-bold underline"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* 9-Section Navigation Tabs */}
            <nav
              aria-label="Admin Dashboard Navigation"
              className="bg-white border border-[#dce8df] rounded-2xl p-2 flex flex-wrap gap-1.5 shadow-2xs"
            >
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`admin-tab-${item.id}`}
                  onClick={() => setActiveTab(item.id)}
                  className={`px-3 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-colors ${
                    activeTab === item.id
                      ? 'bg-[#087e50] text-white shadow-xs'
                      : 'text-[#365845] hover:bg-[#eff7f2]'
                  }`}
                >
                  {item.icon}
                  <span>{lang === 'am' ? item.labelAm : item.labelEn}</span>
                </button>
              ))}
            </nav>

            {/* SECTION 1: OVERVIEW */}
            {activeTab === 'overview' && overview && (
              <div className="space-y-4" data-testid="admin-section-overview">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-white border border-[#dce8df] rounded-2xl p-4">
                    <small className="text-[11px] font-bold text-[#5c7868] uppercase">
                      Total Players
                    </small>
                    <div className="font-['Outfit'] text-2xl font-black text-[#193b2b] mt-1">
                      {overview.totalUsers}
                    </div>
                    <span className="text-[11px] text-[#087e50] font-bold">
                      {overview.activeUsers} active · {overview.suspendedUsers} suspended
                    </span>
                  </div>

                  <div className="bg-white border border-[#dce8df] rounded-2xl p-4">
                    <small className="text-[11px] font-bold text-[#5c7868] uppercase">
                      Demo Payout Orders
                    </small>
                    <div className="font-['Outfit'] text-2xl font-black text-[#193b2b] mt-1">
                      {overview.payoutCounts.total}
                    </div>
                    <span className="text-[11px] text-amber-700 font-bold">
                      {overview.payoutCounts.Pending} Pending ·{' '}
                      {overview.payoutCounts['Under Review']} Under Review
                    </span>
                  </div>

                  <div className="bg-white border border-[#dce8df] rounded-2xl p-4">
                    <small className="text-[11px] font-bold text-[#5c7868] uppercase">
                      Telegram Bot Activity
                    </small>
                    <div className="font-['Outfit'] text-2xl font-black text-[#193b2b] mt-1">
                      {overview.botStats.totalUpdatesProcessed}
                    </div>
                    <span className="text-[11px] text-[#087e50] font-bold">
                      {overview.botStats.callbacksHandled} callbacks ·{' '}
                      {overview.botStats.duplicateCallbacksBlocked} replays blocked
                    </span>
                  </div>

                  <div className="bg-white border border-[#dce8df] rounded-2xl p-4">
                    <small className="text-[11px] font-bold text-[#5c7868] uppercase">
                      SHA-256 Audit Chain
                    </small>
                    <div className="font-['Outfit'] text-2xl font-black text-[#087e50] mt-1 flex items-center gap-1.5">
                      <ShieldCheck size={22} />
                      {overview.auditTrailEntries}
                    </div>
                    <span className="text-[11px] text-[#087e50] font-bold">
                      Integrity: {overview.auditIntegrity.valid ? 'VERIFIED ✓' : 'BROKEN'}
                    </span>
                  </div>
                </div>

                <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                        Role Separation & Security Posture
                      </h3>
                      <p className="text-xs text-[#547060] m-0">
                        Every administrative endpoint validates session identity on the server and records an immutable SHA-256 audit log entry.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => loadAllAdminData()}
                      className="px-3 py-1.5 rounded-xl bg-[#eef7f1] text-[#087e50] text-xs font-extrabold flex items-center gap-1"
                    >
                      <RefreshCw size={13} />
                      Refresh Metrics
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className="p-3.5 rounded-xl bg-[#f7fbf8] border border-[#e1efe6]">
                      <b className="text-[#087e50] block mb-1">✓ Server-Side Role Guard</b>
                      Normal players receive HTTP 403 on all <code>/api/admin/*</code> routes. Frontend flags or <code>localStorage</code> are never trusted.
                    </div>
                    <div className="p-3.5 rounded-xl bg-[#f7fbf8] border border-[#e1efe6]">
                      <b className="text-[#087e50] block mb-1">✓ Phone PII Isolation</b>
                      Raw phone numbers remain isolated in <code>/users/&#123;uid&#125;/private/contact</code>; only masked numbers are displayed.
                    </div>
                    <div className="p-3.5 rounded-xl bg-[#f7fbf8] border border-[#e1efe6]">
                      <b className="text-[#087e50] block mb-1">✓ Demo Sandbox Financial Mode</b>
                      All payout orders and deposit requests operate strictly in non-monetary Demo ETB mode.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* SECTION 2: USER MANAGEMENT */}
            {activeTab === 'users' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" data-testid="admin-section-users">
                <div className="lg:col-span-2 bg-white border border-[#dce8df] rounded-2xl p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                        User Management ({users.length})
                      </h3>
                      <p className="text-xs text-[#547060] m-0">
                        Search by name, Telegram ID, or account UID. Raw phone contacts are masked for privacy.
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 bg-[#f4faf6] border border-[#d6e8dc] rounded-xl px-3 py-1.5">
                      <Search size={14} className="text-[#087e50]" />
                      <input
                        type="text"
                        data-testid="admin-user-search-input"
                        value={userSearchQuery}
                        onChange={(e) => handleSearchUsers(e.target.value)}
                        placeholder="Search name, TG ID, uid..."
                        className="bg-transparent border-0 text-xs font-bold text-[#193b2b] focus:outline-none w-48"
                      />
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-[#e5efe8] text-[#587464] uppercase text-[10px]">
                          <th className="py-2 px-2">Player</th>
                          <th className="py-2 px-2">Telegram ID</th>
                          <th className="py-2 px-2">Phone (Masked)</th>
                          <th className="py-2 px-2">Demo Wallet</th>
                          <th className="py-2 px-2">Status</th>
                          <th className="py-2 px-2">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#eef5f0]">
                        {users.map((u) => (
                          <tr
                            key={u.uid}
                            onClick={() => setSelectedUser(u)}
                            className={`cursor-pointer hover:bg-[#f6fbf8] ${
                              selectedUser?.uid === u.uid ? 'bg-[#edf8f1]' : ''
                            }`}
                          >
                            <td className="py-2.5 px-2 font-bold text-[#193b2b]">
                              {u.displayName}
                              <span className="block text-[10px] font-mono text-[#688273]">
                                @{u.username} · {u.uid}
                              </span>
                            </td>
                            <td className="py-2.5 px-2 font-mono">TG #{u.telegramUserId}</td>
                            <td className="py-2.5 px-2 font-mono">
                              {u.phoneVerified ? (
                                <span className="text-[#087e50] font-bold">✓ {u.maskedPhone}</span>
                              ) : (
                                <span className="text-amber-700">Unverified</span>
                              )}
                            </td>
                            <td className="py-2.5 px-2 font-extrabold">
                              {u.demoBalanceEtb.toFixed(2)} ETB
                            </td>
                            <td className="py-2.5 px-2">
                              <span
                                className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase ${
                                  u.accountStatus === 'active'
                                    ? 'bg-[#e7f8ed] text-[#087e50]'
                                    : 'bg-red-100 text-red-800'
                                }`}
                              >
                                {u.accountStatus}
                              </span>
                            </td>
                            <td className="py-2.5 px-2">
                              <button
                                type="button"
                                data-testid={`toggle-user-status-${u.uid}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleToggleUserStatus(u);
                                }}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold ${
                                  u.accountStatus === 'active'
                                    ? 'bg-red-50 text-red-700 hover:bg-red-100'
                                    : 'bg-[#e7f8ed] text-[#087e50] hover:bg-[#d3f2df]'
                                }`}
                              >
                                {u.accountStatus === 'active' ? 'Suspend' : 'Reactivate'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Selected User Inspector */}
                <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-3">
                  {selectedUser ? (
                    <>
                      <div className="flex items-center justify-between">
                        <h4 className="font-['Outfit'] text-sm font-extrabold text-[#193b2b] m-0">
                          Account Inspector: {selectedUser.displayName}
                        </h4>
                        <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[#eff7f2] text-[#087e50] font-bold">
                          {selectedUser.role.toUpperCase()}
                        </span>
                      </div>

                      <div className="text-xs space-y-1.5 bg-[#f7fbf8] p-3 rounded-xl border border-[#e2efe6]">
                        <div>
                          <b>Account UID:</b> <code>{selectedUser.uid}</code>
                        </div>
                        <div>
                          <b>Telegram ID:</b> <code>TG #{selectedUser.telegramUserId}</code>
                        </div>
                        <div>
                          <b>Masked Contact:</b> <code>{selectedUser.maskedPhone}</code>
                        </div>
                        <div>
                          <b>Activity:</b> {selectedUser.gamesPlayed} games played ·{' '}
                          {selectedUser.gamesWon} won
                        </div>
                        <div>
                          <b>Referral Code:</b> <code>{selectedUser.referralCode}</code> (
                          {selectedUser.referralsCount} invited)
                        </div>
                        {selectedUser.suspensionReason && (
                          <div className="text-red-700 font-bold">
                            <b>Suspension Note:</b> {selectedUser.suspensionReason}
                          </div>
                        )}
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] font-bold text-[#486655] block">
                          Audit Reason for Account Status Change:
                        </label>
                        <input
                          type="text"
                          value={statusReasonInput}
                          onChange={(e) => setStatusReasonInput(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-xl border border-[#d5e7dc] text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => handleToggleUserStatus(selectedUser)}
                          className="w-full mt-1.5 px-3 py-2 rounded-xl bg-[#087e50] text-white text-xs font-extrabold flex items-center justify-center gap-1.5"
                        >
                          <UserX size={14} />
                          {selectedUser.accountStatus === 'active'
                            ? 'Suspend Account (Record Audit)'
                            : 'Reactivate Account (Record Audit)'}
                        </button>
                      </div>

                      <div className="pt-2 border-t border-[#e8f1eb] space-y-1.5">
                        <b className="text-xs text-[#193b2b] block">
                          Demo Wallet Ledger ({selectedUser.walletLedger.length})
                        </b>
                        {selectedUser.walletLedger.length === 0 ? (
                          <p className="text-xs text-[#6c8476]">No ledger entries recorded.</p>
                        ) : (
                          selectedUser.walletLedger.map((tx) => (
                            <div
                              key={tx.id}
                              className="p-2 rounded-lg bg-[#f9fcfa] border border-[#e3eee7] text-[11px] flex items-center justify-between"
                            >
                              <div>
                                <b className="block text-[#193b2b]">{tx.description}</b>
                                <span className="font-mono text-[10px] text-[#6a8274]">
                                  {tx.reference} · {tx.timestamp}
                                </span>
                              </div>
                              <b
                                className={
                                  tx.amountEtb >= 0 ? 'text-[#087e50]' : 'text-amber-700'
                                }
                              >
                                {tx.amountEtb >= 0 ? `+${tx.amountEtb}` : tx.amountEtb} ETB
                              </b>
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-[#5c7868]">Select a user to inspect details.</p>
                  )}
                </div>
              </div>
            )}

            {/* SECTION 3: PAYOUT ORDERS (DEMO-ONLY) */}
            {activeTab === 'payouts' && (
              <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-4" data-testid="admin-section-payouts">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
                      DEMO SANDBOX ONLY · NO REAL-MONEY PAYOUTS
                    </span>
                    <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] mt-1 mb-0">
                      Payout Order Management ({payouts.length})
                    </h3>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {['ALL', ...PAYOUT_STATUSES].map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={async () => {
                          setPayoutFilter(st);
                          const resp = await fetch(
                            `/api/admin/payouts?status=${encodeURIComponent(st)}`,
                            { headers: { 'x-adey-session-token': sessionToken } }
                          );
                          if (resp.ok) {
                            const d = await resp.json();
                            setPayouts(d.payouts || []);
                          }
                        }}
                        className={`px-2.5 py-1 rounded-lg text-xs font-extrabold ${
                          payoutFilter === st
                            ? 'bg-[#087e50] text-white'
                            : 'bg-[#f2f9f4] text-[#3c5e4b]'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  {payouts.map((po) => (
                    <div
                      key={po.requestId}
                      data-testid={`payout-order-${po.requestId}`}
                      className="p-4 rounded-2xl bg-[#f8fcfa] border border-[#dcece1] space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-mono text-xs font-black text-[#087e50]">
                            {po.requestId}
                          </span>
                          <span className="mx-2 text-[#9ab0a2]">•</span>
                          <b className="text-sm text-[#193b2b]">{po.userDisplayName}</b>
                          <span className="text-xs font-mono text-[#5c7868] ml-2">
                            (TG #{po.telegramUserId} · {po.uid})
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-['Outfit'] text-base font-black text-[#193b2b]">
                            {po.requestedAmountEtb.toFixed(2)} ETB (Demo)
                          </span>
                          <span
                            data-testid={`payout-status-${po.requestId}`}
                            className={`px-2.5 py-1 rounded-lg text-xs font-extrabold ${
                              po.status === 'Completed' || po.status === 'Approved'
                                ? 'bg-[#e7f8ed] text-[#087e50]'
                                : po.status === 'Rejected'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-amber-100 text-amber-900'
                            }`}
                          >
                            {po.status}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-[#486655]">
                        <div>
                          <b>Request Date:</b> {po.requestDate}
                        </div>
                        <div>
                          <b>Payment Method:</b> {po.paymentMethod} ({po.destinationMasked})
                        </div>
                        <div>
                          <b>Latest Review Note:</b> {po.reviewNotes}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <input
                          type="text"
                          data-testid={`payout-note-input-${po.requestId}`}
                          value={payoutNotesById[po.requestId] ?? ''}
                          onChange={(e) =>
                            setPayoutNotesById((prev) => ({
                              ...prev,
                              [po.requestId]: e.target.value,
                            }))
                          }
                          placeholder="Add admin review note for audit trail..."
                          className="flex-1 min-w-[220px] px-3 py-1.5 rounded-xl bg-white border border-[#cfe3d6] text-xs"
                        />
                        {PAYOUT_STATUSES.map((nextSt) => (
                          <button
                            key={nextSt}
                            type="button"
                            data-testid={`payout-btn-${po.requestId}-${nextSt.replace(/\s+/g, '_')}`}
                            onClick={() => handleReviewPayout(po.requestId, nextSt)}
                            className={`px-2.5 py-1.5 rounded-xl text-xs font-extrabold transition-colors ${
                              po.status === nextSt
                                ? 'bg-[#193b2b] text-white'
                                : 'bg-white border border-[#cfe3d6] text-[#193b2b] hover:bg-[#e8f5ed]'
                            }`}
                          >
                            {nextSt}
                          </button>
                        ))}
                      </div>

                      {/* Per-Order Immutable Status History */}
                      <div className="pt-2 border-t border-[#e5f0e8] text-[11px] space-y-1">
                        <b className="text-[#486655] block">
                          Immutable Payout Audit Trail ({po.auditTrail.length} transitions):
                        </b>
                        {po.auditTrail.map((tr, idx) => (
                          <div key={idx} className="font-mono text-[#567262]">
                            [{tr.timestamp}] {tr.fromStatus} → <b>{tr.toStatus}</b> by{' '}
                            {tr.reviewedBy} ({tr.notes})
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SECTION 4: DEPOSIT REQUESTS (DEMO-ONLY) */}
            {activeTab === 'deposits' && (
              <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-4" data-testid="admin-section-deposits">
                <div>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#087e50] bg-[#e7f8ed] px-2 py-0.5 rounded">
                    DEMO SANDBOX DEPOSIT REQUESTS
                  </span>
                  <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] mt-1 mb-0">
                    Deposit Request Queue ({deposits.length})
                  </h3>
                </div>

                <div className="space-y-3">
                  {deposits.map((dep) => (
                    <div
                      key={dep.depositId}
                      className="p-4 rounded-2xl bg-[#f8fcfa] border border-[#dcece1] flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="space-y-1 text-xs">
                        <div>
                          <span className="font-mono font-black text-[#087e50]">
                            {dep.depositId}
                          </span>{' '}
                          · <b>{dep.userDisplayName}</b> (TG #{dep.telegramUserId})
                        </div>
                        <div className="text-[#526e5e]">
                          Amount: <b>{dep.amountEtb.toFixed(2)} ETB (Demo)</b> · Provider:{' '}
                          {dep.provider} · Ref: <code>{dep.referenceCode}</code>
                        </div>
                        <div className="text-[#668071]">Note: {dep.reviewNotes}</div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={depositNotesById[dep.depositId] ?? ''}
                          onChange={(e) =>
                            setDepositNotesById((prev) => ({
                              ...prev,
                              [dep.depositId]: e.target.value,
                            }))
                          }
                          placeholder="Review note..."
                          className="px-3 py-1.5 rounded-xl bg-white border border-[#cfe3d6] text-xs"
                        />
                        {DEPOSIT_STATUSES.map((st) => (
                          <button
                            key={st}
                            type="button"
                            onClick={() => handleReviewDeposit(dep.depositId, st)}
                            className={`px-3 py-1.5 rounded-xl text-xs font-extrabold ${
                              dep.status === st
                                ? 'bg-[#087e50] text-white'
                                : 'bg-white border border-[#cfe3d6] text-[#193b2b]'
                            }`}
                          >
                            {st}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SECTION 5: GAME ROOM MANAGEMENT */}
            {activeTab === 'rooms' && (
              <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-4" data-testid="admin-section-rooms">
                <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                  Game Room Management (1–600 Cards · Max 4 Cards/Player)
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {rooms.map((rm) => (
                    <div
                      key={rm.id}
                      className="p-4 rounded-2xl bg-[#f8fcfa] border border-[#dcece1] space-y-3 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <b className="text-sm text-[#193b2b] block">{rm.nameEn}</b>
                          <span className="text-[#5c7868]">{rm.nameAm}</span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-[#e7f8ed] text-[#087e50] font-extrabold uppercase">
                          {rm.status}
                        </span>
                      </div>

                      <div className="space-y-1 text-[#486655]">
                        <div>
                          Card Capacity: <b>{rm.maxCardsPerRoom} cards</b> (Max{' '}
                          {rm.maxCardsPerPlayer}/player)
                        </div>
                        <div>
                          Entry Fee: <b>{rm.cardPriceEtb} ETB (Demo)</b>
                        </div>
                        <div>
                          Lobby Countdown: <b>{rm.lobbyCountdownSeconds}s</b> · Min Players:{' '}
                          <b>{rm.minPlayers}</b>
                        </div>
                        <div>
                          Online Players: <b>{rm.activePlayers}</b>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5 pt-2">
                        {[10, 15, 20].map((price) => (
                          <button
                            key={price}
                            type="button"
                            onClick={() => handleUpdateRoom(rm.id, { cardPriceEtb: price })}
                            className={`px-2.5 py-1 rounded-lg font-extrabold ${
                              rm.cardPriceEtb === price
                                ? 'bg-[#087e50] text-white'
                                : 'bg-white border border-[#cfe3d6]'
                            }`}
                          >
                            {price} ETB
                          </button>
                        ))}
                        {(['open', 'live', 'maintenance'] as const).map((st) => (
                          <button
                            key={st}
                            type="button"
                            onClick={() => handleUpdateRoom(rm.id, { status: st })}
                            className={`px-2.5 py-1 rounded-lg font-extrabold uppercase ${
                              rm.status === st
                                ? 'bg-[#193b2b] text-white'
                                : 'bg-white border border-[#cfe3d6]'
                            }`}
                          >
                            {st}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SECTION 6: REFERRAL MANAGEMENT */}
            {activeTab === 'referrals' && (
              <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-4" data-testid="admin-section-referrals">
                <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                  Referral Management (+20 ETB Inviter / +15 ETB Invitee Demo Bonus)
                </h3>
                <div className="space-y-2.5">
                  {referrals.map((rf) => (
                    <div
                      key={rf.id}
                      className="p-3.5 rounded-xl bg-[#f8fcfa] border border-[#dcece1] flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div>
                        <b>{rf.inviterName}</b> (<code>TG #{rf.inviterTelegramId}</code>) invited{' '}
                        <b>{rf.inviteeName}</b> (<code>{rf.inviteeHandle}</code>)
                        <span className="block text-[11px] text-[#668071]">
                          Joined: {rf.joinedAt}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="px-2.5 py-1 rounded-lg bg-[#e7f8ed] text-[#087e50] font-extrabold">
                          +{rf.inviterBonusEtb} / +{rf.inviteeBonusEtb} ETB Demo
                        </span>
                        <span className="px-2.5 py-1 rounded-lg bg-[#193b2b] text-white font-extrabold uppercase">
                          {rf.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SECTION 7: BOT MANAGEMENT */}
            {activeTab === 'bot' && botConfig && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="admin-section-bot">
                <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-3">
                  <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                    Telegram Bot Welcome & Button Configuration
                  </h3>
                  <p className="text-xs text-[#547060] m-0">
                    Changes are validated and stored persistently on the backend and logged to the SHA-256 audit chain.
                  </p>

                  <div className="space-y-2 text-xs">
                    <label className="font-bold block text-[#355644]">
                      Mini App Destination URL (HTTPS):
                    </label>
                    <input
                      type="text"
                      value={miniAppUrlDraft}
                      onChange={(e) => setMiniAppUrlDraft(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-[#cfe3d6] font-mono text-xs"
                    />

                    <label className="font-bold block text-[#355644]">
                      Custom /start Welcome Prefix (Amharic · አማርኛ):
                    </label>
                    <textarea
                      rows={2}
                      data-testid="bot-welcome-am-input"
                      value={welcomeAmDraft}
                      onChange={(e) => setWelcomeAmDraft(e.target.value)}
                      placeholder="Optional custom Amharic welcome header..."
                      className="w-full px-3 py-2 rounded-xl border border-[#cfe3d6] text-xs"
                    />

                    <label className="font-bold block text-[#355644]">
                      Custom /start Welcome Prefix (English):
                    </label>
                    <textarea
                      rows={2}
                      data-testid="bot-welcome-en-input"
                      value={welcomeEnDraft}
                      onChange={(e) => setWelcomeEnDraft(e.target.value)}
                      placeholder="Optional custom English welcome header..."
                      className="w-full px-3 py-2 rounded-xl border border-[#cfe3d6] text-xs"
                    />

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="font-bold block text-[#355644]">
                          Play Button Label (AM):
                        </label>
                        <input
                          type="text"
                          value={playLabelAmDraft}
                          onChange={(e) => setPlayLabelAmDraft(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-xl border border-[#cfe3d6] text-xs"
                        />
                      </div>
                      <div>
                        <label className="font-bold block text-[#355644]">
                          Play Button Label (EN):
                        </label>
                        <input
                          type="text"
                          value={playLabelEnDraft}
                          onChange={(e) => setPlayLabelEnDraft(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-xl border border-[#cfe3d6] text-xs"
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      data-testid="save-bot-config-btn"
                      onClick={handleSaveBotConfig}
                      className="px-4 py-2.5 rounded-xl bg-[#087e50] text-white text-xs font-extrabold flex items-center gap-1.5"
                    >
                      <CheckCircle2 size={14} />
                      Save Bot Configuration
                    </button>
                  </div>
                </div>

                {/* Bot Announcements & Delivery Status */}
                <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-3">
                  <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                    Broadcast Announcement & Delivery Status
                  </h3>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="p-2.5 rounded-xl bg-[#f4faf6] border border-[#dcece1]">
                      <small className="text-[10px] text-[#5c7868] block">Updates</small>
                      <b className="text-sm">{botConfig.stats.totalUpdatesProcessed}</b>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#f4faf6] border border-[#dcece1]">
                      <small className="text-[10px] text-[#5c7868] block">Callbacks</small>
                      <b className="text-sm">{botConfig.stats.callbacksHandled}</b>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#f4faf6] border border-[#dcece1]">
                      <small className="text-[10px] text-[#5c7868] block">Replays Blocked</small>
                      <b className="text-sm">{botConfig.stats.duplicateCallbacksBlocked}</b>
                    </div>
                    <div className="p-2.5 rounded-xl bg-[#f4faf6] border border-[#dcece1]">
                      <small className="text-[10px] text-[#5c7868] block">Broadcasts</small>
                      <b className="text-sm">{botConfig.stats.announcementsSent}</b>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    <input
                      type="text"
                      value={announceTitleAm}
                      onChange={(e) => setAnnounceTitleAm(e.target.value)}
                      placeholder="Amharic Title"
                      className="w-full px-3 py-1.5 rounded-xl border border-[#cfe3d6]"
                    />
                    <textarea
                      rows={2}
                      value={announceBodyAm}
                      onChange={(e) => setAnnounceBodyAm(e.target.value)}
                      placeholder="Amharic Announcement Body"
                      className="w-full px-3 py-1.5 rounded-xl border border-[#cfe3d6]"
                    />
                    <input
                      type="text"
                      value={announceTitleEn}
                      onChange={(e) => setAnnounceTitleEn(e.target.value)}
                      placeholder="English Title"
                      className="w-full px-3 py-1.5 rounded-xl border border-[#cfe3d6]"
                    />
                    <textarea
                      rows={2}
                      value={announceBodyEn}
                      onChange={(e) => setAnnounceBodyEn(e.target.value)}
                      placeholder="English Announcement Body"
                      className="w-full px-3 py-1.5 rounded-xl border border-[#cfe3d6]"
                    />
                    <button
                      type="button"
                      data-testid="send-bot-announcement-btn"
                      onClick={handleSendAnnouncement}
                      className="px-4 py-2 rounded-xl bg-[#193b2b] text-white text-xs font-extrabold flex items-center gap-1.5"
                    >
                      <Send size={13} />
                      Send Bot Announcement
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* SECTION 8: NOTIFICATIONS */}
            {activeTab === 'notifications' && (
              <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-3" data-testid="admin-section-notifications">
                <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                  Telegram Bot Notification Outbox ({notificationsOutbox.length})
                </h3>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {notificationsOutbox.map((ntf) => (
                    <div
                      key={ntf.id}
                      className="p-3 rounded-xl bg-[#f8fcfa] border border-[#dcece1] text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <b className="text-[#087e50]">{ntf.title}</b>
                        <span className="font-mono text-[10px] text-[#5c7868]">
                          {ntf.event} · TG #{ntf.telegramUserId} ({ntf.language.toUpperCase()})
                        </span>
                      </div>
                      <p className="text-[#355644] m-0">{ntf.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SECTION 9: ADMIN SETTINGS & IMMUTABLE AUDIT LOG */}
            {activeTab === 'settings' && adminSettings && (
              <div className="bg-white border border-[#dce8df] rounded-2xl p-5 space-y-4" data-testid="admin-section-settings">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-['Outfit'] text-base font-extrabold text-[#193b2b] m-0">
                      Admin Settings & Immutable SHA-256 Audit Trail
                    </h3>
                    <p className="text-xs text-[#547060] m-0">
                      Authorized Admin Telegram IDs:{' '}
                      <code>{adminSettings.authorizedAdminTelegramIds.join(', ')}</code> · Emails:{' '}
                      <code>{adminSettings.authorizedAdminEmails.join(', ')}</code>
                    </p>
                  </div>
                  <span className="px-3 py-1 rounded-xl bg-[#e7f8ed] text-[#087e50] text-xs font-extrabold">
                    Audit Chain Integrity:{' '}
                    {adminSettings.auditChainIntegrity.valid ? 'VALID ✓' : 'INVALID'} (
                    {adminSettings.auditChainIntegrity.totalEntries} records)
                  </span>
                </div>

                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {adminSettings.auditTrail.map((aud) => (
                    <div
                      key={aud.id}
                      className="p-3 rounded-xl bg-[#f8fcfa] border border-[#dcece1] text-xs space-y-1"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-bold text-[#087e50]">
                          #{aud.sequence} · {aud.action} · Target: {aud.targetId}
                        </span>
                        <span className="font-mono text-[10px] text-[#668071]">
                          {aud.timestamp} · Actor: {aud.adminName} ({aud.adminUid})
                        </span>
                      </div>
                      <div className="text-[#193b2b] font-bold">{aud.summary}</div>
                      {aud.notes && (
                        <div className="text-[#526e5e]">Review Notes: {aud.notes}</div>
                      )}
                      <div className="font-mono text-[10px] text-[#7a9283] truncate">
                        SHA-256: {aud.entryHash} (prev: {aud.prevHash.slice(0, 16)}...)
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
