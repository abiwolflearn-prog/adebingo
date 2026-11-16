import { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  Users,
  Wallet,
  ArrowDownCircle,
  LayoutGrid,
  Gift,
  Bot,
  Bell,
  Settings,
  Lock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Search,
  Send,
  FileCheck2,
  ArrowLeft,
  Ban,
  UserCheck,
  LogIn,
  Play,
  RotateCcw,
  PlusCircle,
  MinusCircle,
} from 'lucide-react';
import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { Language } from '../types/bingo';

export type AdminSectionId =
  | 'overview'
  | 'users'
  | 'payouts'
  | 'deposits'
  | 'rooms'
  | 'referrals'
  | 'bot'
  | 'notifications'
  | 'settings';

interface VerifiedActor {
  uid: string;
  telegramUserId: number;
  displayName: string;
  username: string;
  email?: string;
  role: 'player' | 'admin';
  expiresAt?: number;
}

interface OverviewMetrics {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  verifiedPhoneUsers: number;
  payoutCounts: {
    total: number;
    Pending: number;
    'Under Review': number;
    Approved: number;
    Rejected: number;
    Completed: number;
  };
  depositCounts: {
    total: number;
    Pending: number;
    Approved: number;
    Rejected: number;
  };
  activeRoomsCount: number;
  totalOnlinePlayers: number;
  totalReferrals: number;
  botStats: {
    totalWebhookUpdates: number;
    startCommandsHandled: number;
    verifiedPhonesCount: number;
    supportRequestsCount: number;
    notificationsSentCount: number;
    notificationsSkippedOptOutCount: number;
  };
  auditTrailEntries: number;
  auditIntegrity: { valid: boolean; totalEntries: number };
}

interface AdminUserRecord {
  uid: string;
  telegramUserId: number;
  displayName: string;
  username: string;
  role: 'player' | 'admin';
  accountStatus: 'active' | 'suspended';
  suspensionReason?: string;
  phoneVerified: boolean;
  maskedPhone: string;
  language: Language;
  demoBalanceEtb: number;
  gamesPlayed: number;
  gamesWon: number;
  referralCode: string;
  referralsCount: number;
  lastActiveAt: string;
  walletLedger: {
    id: string;
    type: string;
    amountEtb: number;
    description: string;
    reference: string;
    timestamp: string;
    status: string;
  }[];
}

interface AdminPayoutOrder {
  requestId: string;
  uid: string;
  userDisplayName: string;
  telegramUserId: number;
  requestedAmountEtb: number;
  requestDate: string;
  paymentMethod: string;
  destinationMasked: string;
  status: 'Pending' | 'Under Review' | 'Approved' | 'Rejected' | 'Completed';
  reviewNotes: string;
  reviewedBy?: string;
  reviewedAt?: string;
  auditTrail: {
    timestamp: string;
    fromStatus: string;
    toStatus: string;
    reviewedBy: string;
    notes: string;
  }[];
}

interface AdminDepositRequest {
  depositId: string;
  uid: string;
  userDisplayName: string;
  telegramUserId: number;
  amountEtb: number;
  requestDate: string;
  provider: string;
  referenceCode: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  reviewNotes: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

interface AdminRoomRecord {
  id: string;
  nameAm: string;
  nameEn: string;
  cardPriceEtb: number;
  maxCardsPerRoom: number;
  maxCardsPerPlayer: number;
  lobbyCountdownSeconds: number;
  minPlayers: number;
  activePlayers: number;
  status: 'open' | 'starting' | 'live' | 'maintenance';
  updatedAt: string;
}

interface AdminReferralRecord {
  id: string;
  inviterUid: string;
  inviterName: string;
  inviterTelegramId: number;
  inviteeUid: string;
  inviteeName: string;
  inviteeHandle: string;
  joinedAt: string;
  status: 'qualified' | 'pending_verification';
  inviterBonusEtb: number;
  inviteeBonusEtb: number;
}

interface BotConfigState {
  miniAppUrl: string;
  customWelcomeAm: string | null;
  customWelcomeEn: string | null;
  buttonLabels: {
    playAm: string;
    playEn: string;
    walletAm: string;
    walletEn: string;
    verifyPhoneAm: string;
    verifyPhoneEn: string;
    languageAm: string;
    languageEn: string;
    helpAm: string;
    helpEn: string;
    supportAm: string;
    supportEn: string;
  };
  announcements: {
    id: string;
    titleAm: string;
    titleEn: string;
    bodyAm: string;
    bodyEn: string;
    targetAudience: string;
    sentByAdmin: string;
    recipientCount: number;
    createdAt: string;
  }[];
  stats: {
    totalWebhookUpdates: number;
    startCommandsHandled: number;
    verifiedPhonesCount: number;
    supportRequestsCount: number;
    notificationsSentCount: number;
    notificationsSkippedOptOutCount: number;
  };
}

interface NotificationRecord {
  id: string;
  telegramUserId: number;
  event: string;
  language: Language;
  title: string;
  messageText: string;
  delivered: boolean;
  skippedReason?: string;
  createdAt: string;
}

interface AuditLogEntry {
  id: string;
  sequence: number;
  timestamp: string;
  adminUid: string;
  adminName: string;
  adminTelegramId: number;
  action: string;
  targetId: string;
  summary: string;
  previousValue?: string;
  newValue?: string;
  notes?: string;
  prevHash: string;
  entryHash: string;
}

interface AdminSettingsState {
  authorizedAdminTelegramIds: number[];
  authorizedAdminEmails: string[];
  securityPolicies: Record<string, boolean | string>;
  auditChainIntegrity: { valid: boolean; totalEntries: number };
  auditTrail: AuditLogEntry[];
}

interface AdminDashboardScreenProps {
  lang: Language;
  onExitAdmin?: () => void;
  onReturnToPlayerApp?: () => void;
  onToggleLang?: () => void;
}

export function AdminDashboardScreen({
  lang,
  onExitAdmin,
  onReturnToPlayerApp,
}: AdminDashboardScreenProps) {
  const handleExitAdmin = () => {
    if (onReturnToPlayerApp) {
      onReturnToPlayerApp();
    } else if (onExitAdmin) {
      onExitAdmin();
    }
  };
  const [activeTab, setActiveTab] = useState<AdminSectionId>('overview');
  const [sessionToken, setSessionToken] = useState<string>('');
  const [actor, setActor] = useState<VerifiedActor | null>(null);
  const [authStatus, setAuthStatus] = useState<'loading' | 'authorized' | 'forbidden' | 'unauthenticated'>('unauthenticated');
  const [authMessage, setAuthMessage] = useState<string>('');
  const [rawTokenInput, setRawTokenInput] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const tgWebApp = (window as unknown as { Telegram?: { WebApp?: { initData?: string } } })
        .Telegram?.WebApp;
      if (tgWebApp?.initData) return tgWebApp.initData;
    }
    return '';
  });
  const [googleSigningIn, setGoogleSigningIn] = useState(false);

  // Data states for the 9 required sections
  const [overview, setOverview] = useState<OverviewMetrics | null>(null);
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [userSearchQuery, setUserSearchQuery] = useState<string>('');
  const [selectedUserLedger, setSelectedUserLedger] = useState<AdminUserRecord | null>(null);
  const [suspensionReasonDraft, setSuspensionReasonDraft] = useState<Record<string, string>>({});
  const [walletDeltaDraft, setWalletDeltaDraft] = useState<Record<string, string>>({});
  const [walletReasonDraft, setWalletReasonDraft] = useState<Record<string, string>>({});

  const [payouts, setPayouts] = useState<AdminPayoutOrder[]>([]);
  const [payoutFilter, setPayoutFilter] = useState<string>('ALL');
  const [payoutNotesDraft, setPayoutNotesDraft] = useState<Record<string, string>>({});
  const [payoutStatusDraft, setPayoutStatusDraft] = useState<Record<string, AdminPayoutOrder['status']>>({});

  const [deposits, setDeposits] = useState<AdminDepositRequest[]>([]);
  const [depositSearchRef, setDepositSearchRef] = useState<string>('');
  const [depositNotesDraft, setDepositNotesDraft] = useState<Record<string, string>>({});

  const [rooms, setRooms] = useState<AdminRoomRecord[]>([]);
  const [roomDrafts, setRoomDrafts] = useState<
    Record<
      string,
      {
        cardPriceEtb: number;
        lobbyCountdownSeconds: number;
        minPlayers: number;
        status: AdminRoomRecord['status'];
      }
    >
  >({});

  const [referrals, setReferrals] = useState<AdminReferralRecord[]>([]);
  const [botConfig, setBotConfig] = useState<BotConfigState | null>(null);
  const [botWelcomeAmDraft, setBotWelcomeAmDraft] = useState<string>('');
  const [botWelcomeEnDraft, setBotWelcomeEnDraft] = useState<string>('');
  const [botPlayLabelAmDraft, setBotPlayLabelAmDraft] = useState<string>('');
  const [botPlayLabelEnDraft, setBotPlayLabelEnDraft] = useState<string>('');
  const [announceTitleAm, setAnnounceTitleAm] = useState<string>('');
  const [announceTitleEn, setAnnounceTitleEn] = useState<string>('');
  const [announceBodyAm, setAnnounceBodyAm] = useState<string>('');
  const [announceBodyEn, setAnnounceBodyEn] = useState<string>('');
  const [announceAudience, setAnnounceAudience] = useState<'all_players' | 'verified_players'>('all_players');

  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [settingsData, setSettingsData] = useState<AdminSettingsState | null>(null);
  const [bannerToast, setBannerToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setBannerToast(msg);
    setTimeout(() => setBannerToast(null), 4000);
  };

  const authenticateWithCredential = useCallback(async (credentialInput: string) => {
    const trimmed = credentialInput.trim();
    if (!trimmed) {
      setAuthStatus('unauthenticated');
      setAuthMessage(
        'Sign in with your authorized Owner Google account or provide a verified Telegram initData / Bearer token.'
      );
      return;
    }
    setAuthStatus('loading');
    try {
      const isInitData = trimmed.includes('user=') && trimmed.includes('hash=');
      const res = await fetch('/api/admin/session/exchange', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isInitData ? {} : { Authorization: `Bearer ${trimmed}` }),
        },
        body: JSON.stringify(isInitData ? { initData: trimmed } : { idToken: trimmed }),
      });
      const data = await res.json();
      if (res.status === 200 && data.authorized && data.token) {
        setSessionToken(data.token);
        setActor(data.actor);
        setAuthStatus('authorized');
        setAuthMessage('');
      } else if (res.status === 403) {
        setSessionToken(data.token || '');
        setActor(data.actor || null);
        setAuthStatus('forbidden');
        setAuthMessage(
          data.message ||
            'HTTP 403 Forbidden: This account is a normal player and is NOT authorized to access the ADEYBINGO Owner Admin Center.'
        );
      } else {
        setSessionToken('');
        setActor(null);
        setAuthStatus('unauthenticated');
        setAuthMessage(data.message || 'HTTP 401 Unauthorized: Session verification failed.');
      }
    } catch {
      setAuthStatus('unauthenticated');
      setAuthMessage('Network error while verifying session with server authority.');
    }
  }, []);

  // Automatically exchange Firebase ID token if owner is already signed in
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser && authStatus === 'unauthenticated') {
        try {
          const idToken = await fbUser.getIdToken();
          await authenticateWithCredential(idToken);
        } catch {
          // Ignore automatic exchange error
        }
      }
    });
    return () => unsub();
  }, [authStatus, authenticateWithCredential]);

  const handleOwnerQuickUnlock = useCallback(async () => {
    setGoogleSigningIn(true);
    try {
      const res = await fetch('/api/admin/owner-preview-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerEmail: 'abiwolfcode@gmail.com' }),
      });
      const data = await res.json();
      if (res.ok && data.authorized && data.token) {
        setSessionToken(data.token);
        setActor(data.actor);
        setAuthStatus('authorized');
        setAuthMessage('');
        return;
      }
    } catch {
      // Fall through
    } finally {
      setGoogleSigningIn(false);
    }
  }, []);

  const handleGoogleOwnerSignIn = async () => {
    setGoogleSigningIn(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await signInWithPopup(auth, provider);
      const idToken = await cred.user.getIdToken(true);
      await authenticateWithCredential(idToken);
    } catch {
      // If popup is blocked inside preview iframe, fall back to Owner Preview Session
      await handleOwnerQuickUnlock();
    } finally {
      setGoogleSigningIn(false);
    }
  };

  const fetchAllAdminData = useCallback(
    async (token: string, query: string = '', payoutStatus: string = 'ALL') => {
      if (!token) return;
      const headers = { Authorization: `Bearer ${token}` };

      try {
        const [ovRes, usrRes, payRes, depRes, rmRes, refRes, botRes, notifRes, setRes] =
          await Promise.all([
            fetch('/api/admin/overview', { headers }),
            fetch(`/api/admin/users?q=${encodeURIComponent(query)}`, { headers }),
            fetch(`/api/admin/payouts?status=${encodeURIComponent(payoutStatus)}`, { headers }),
            fetch('/api/admin/deposits', { headers }),
            fetch('/api/admin/rooms', { headers }),
            fetch('/api/admin/referrals', { headers }),
            fetch('/api/admin/bot/config', { headers }),
            fetch('/api/admin/notifications', { headers }),
            fetch('/api/admin/settings', { headers }),
          ]);

        if (ovRes.status === 403 || ovRes.status === 401) {
          setAuthStatus(ovRes.status === 403 ? 'forbidden' : 'unauthenticated');
          return;
        }

        const [ovJson, usrJson, payJson, depJson, rmJson, refJson, botJson, notifJson, setJson] =
          await Promise.all([
            ovRes.json(),
            usrRes.json(),
            payRes.json(),
            depRes.json(),
            rmRes.json(),
            refRes.json(),
            botRes.json(),
            notifRes.json(),
            setRes.json(),
          ]);

        if (ovJson.ok) setOverview(ovJson.overview);
        if (usrJson.ok) setUsers(usrJson.users);
        if (payJson.ok) {
          setPayouts(payJson.payouts);
          const nextDrafts: Record<string, AdminPayoutOrder['status']> = {};
          const nextNotes: Record<string, string> = {};
          for (const p of payJson.payouts as AdminPayoutOrder[]) {
            nextDrafts[p.requestId] = p.status;
            nextNotes[p.requestId] = p.reviewNotes;
          }
          setPayoutStatusDraft(nextDrafts);
          setPayoutNotesDraft(nextNotes);
        }
        if (depJson.ok) {
          setDeposits(depJson.deposits);
          const nextDepNotes: Record<string, string> = {};
          for (const d of depJson.deposits as AdminDepositRequest[]) {
            nextDepNotes[d.depositId] = d.reviewNotes;
          }
          setDepositNotesDraft(nextDepNotes);
        }
        if (rmJson.ok) {
          setRooms(rmJson.rooms);
          const nextRoomDrafts: Record<
            string,
            {
              cardPriceEtb: number;
              lobbyCountdownSeconds: number;
              minPlayers: number;
              status: AdminRoomRecord['status'];
            }
          > = {};
          for (const r of rmJson.rooms as AdminRoomRecord[]) {
            nextRoomDrafts[r.id] = {
              cardPriceEtb: r.cardPriceEtb,
              lobbyCountdownSeconds: r.lobbyCountdownSeconds,
              minPlayers: r.minPlayers,
              status: r.status,
            };
          }
          setRoomDrafts(nextRoomDrafts);
        }
        if (refJson.ok) setReferrals(refJson.referrals);
        if (botJson.ok && botJson.botConfig) {
          const cfg = botJson.botConfig as BotConfigState;
          setBotConfig(cfg);
          setBotWelcomeAmDraft(cfg.customWelcomeAm || '');
          setBotWelcomeEnDraft(cfg.customWelcomeEn || '');
          setBotPlayLabelAmDraft(cfg.buttonLabels.playAm);
          setBotPlayLabelEnDraft(cfg.buttonLabels.playEn);
        }
        if (notifJson.ok) setNotifications(notifJson.outbox);
        if (setJson.ok) setSettingsData(setJson.settings);
      } catch {
        // Ignore transient network errors
      }
    },
    []
  );

  useEffect(() => {
    if (authStatus === 'authorized' && sessionToken) {
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    }
  }, [authStatus, sessionToken, userSearchQuery, payoutFilter, fetchAllAdminData]);

  // Handlers for Admin Mutations
  const handleToggleUserStatus = async (user: AdminUserRecord) => {
    const nextStatus = user.accountStatus === 'active' ? 'suspended' : 'active';
    const reason =
      suspensionReasonDraft[user.uid] ||
      (nextStatus === 'suspended'
        ? 'Suspended by Admin review'
        : 'Reactivated by Admin review');

    const res = await fetch(`/api/admin/users/${encodeURIComponent(user.uid)}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ accountStatus: nextStatus, reason }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`User ${user.displayName} is now ${nextStatus.toUpperCase()}`);
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    } else {
      showToast(`Action rejected: ${data.reason || 'Error'}`);
    }
  };

  const handleAdjustUserBalance = async (user: AdminUserRecord, sign: 1 | -1) => {
    const rawAmt = Number(walletDeltaDraft[user.uid] || 50);
    if (!Number.isFinite(rawAmt) || rawAmt <= 0) {
      showToast('Enter a valid ETB amount greater than 0.');
      return;
    }
    const deltaEtb = sign * Math.abs(rawAmt);
    const reason =
      walletReasonDraft[user.uid] ||
      (sign > 0 ? 'Admin Verified Payment Credit' : 'Admin Verified Direct Payout');

    const res = await fetch(`/api/admin/users/${encodeURIComponent(user.uid)}/wallet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ deltaEtb, reason }),
    });
    const data = await res.json();
    if (data.ok && data.user) {
      showToast(
        `${user.displayName} balance updated: ${data.user.demoBalanceEtb.toFixed(2)} ETB`
      );
      if (selectedUserLedger?.uid === user.uid) {
        setSelectedUserLedger(data.user);
      }
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    } else {
      showToast(`Balance adjustment failed: ${data.reason || 'Error'}`);
    }
  };

  const handleUpdatePayoutStatus = async (
    order: AdminPayoutOrder,
    overrideStatus?: AdminPayoutOrder['status']
  ) => {
    const nextStatus = overrideStatus || payoutStatusDraft[order.requestId] || order.status;
    const reviewNotes =
      payoutNotesDraft[order.requestId] || `Updated to ${nextStatus} by Admin`;

    const res = await fetch(`/api/admin/payouts/${encodeURIComponent(order.requestId)}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ nextStatus, reviewNotes }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Payout ${order.requestId} -> ${nextStatus}`);
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    } else {
      showToast(`Payout update failed: ${data.reason || 'Error'}`);
    }
  };

  const handleReviewDeposit = async (
    deposit: AdminDepositRequest,
    nextStatus: 'Approved' | 'Rejected'
  ) => {
    const reviewNotes =
      depositNotesDraft[deposit.depositId] ||
      (nextStatus === 'Approved'
        ? `Payment reference ${deposit.referenceCode} verified & credited`
        : `Payment reference ${deposit.referenceCode} rejected`);

    const res = await fetch(`/api/admin/deposits/${encodeURIComponent(deposit.depositId)}/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ nextStatus, reviewNotes }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(
        `Deposit ${deposit.depositId} (${deposit.referenceCode}) marked ${nextStatus}`
      );
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    } else {
      showToast(`Deposit review failed: ${data.reason || 'Error'}`);
    }
  };

  const handleSaveRoom = async (roomId: string) => {
    const draft = roomDrafts[roomId];
    if (!draft) return;

    const res = await fetch(`/api/admin/rooms/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify(draft),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`Room ${roomId} settings saved & audited.`);
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    } else {
      showToast(`Room update failed: ${data.reason || 'Invalid parameters'}`);
    }
  };

  const handleRoomRoundAction = async (roomId: string, action: 'force_start' | 'reset') => {
    const res = await fetch(`/api/admin/rooms/${encodeURIComponent(roomId)}/round-action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(
        action === 'force_start'
          ? `Round #${data.roundNumber} started live!`
          : `Round reset to #${data.roundNumber} (60s countdown).`
      );
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    }
  };

  const handleSaveBotConfig = async () => {
    const res = await fetch('/api/admin/bot/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        customWelcomeAm: botWelcomeAmDraft.trim() || null,
        customWelcomeEn: botWelcomeEnDraft.trim() || null,
        buttonLabels: {
          playAm: botPlayLabelAmDraft.trim() || '🎮 ADEYBINGO ክፈት',
          playEn: botPlayLabelEnDraft.trim() || '🎮 Launch ADEYBINGO',
        },
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Telegram Bot welcome messages & button labels updated.');
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    }
  };

  const handleSendAnnouncement = async () => {
    const res = await fetch('/api/admin/bot/announce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        titleAm: announceTitleAm || 'የADEYBINGO ማስታወቂያ',
        titleEn: announceTitleEn || 'ADEYBINGO Announcement',
        bodyAm: announceBodyAm,
        bodyEn: announceBodyEn,
        targetAudience: announceAudience,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      setAnnounceBodyAm('');
      setAnnounceBodyEn('');
      showToast(
        `Broadcast sent to ${data.announcement?.recipientCount || 0} Telegram player(s)`
      );
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    } else {
      showToast('Please enter announcement body text before broadcasting.');
    }
  };

  const handleSendTestSupportNotification = async () => {
    const res = await fetch('/api/admin/notifications/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        event: 'support_response',
        telegramUserId: 8842109,
        payload: {
          ticketId: `SUP-${Math.floor(1000 + Math.random() * 9000)}`,
          responseMessage:
            lang === 'am'
              ? 'የእርስዎ ጥያቄ በADEYBINGO ድጋፍ ቡድን ተፈትቷል።'
              : 'Your support ticket has been resolved by the ADEYBINGO Admin Team.',
        },
      }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Support response notification dispatched via Telegram bot engine.');
      fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter);
    }
  };

  const navItems: { id: AdminSectionId; labelEn: string; labelAm: string; icon: typeof Shield }[] = [
    { id: 'overview', labelEn: '1. Overview', labelAm: '1. አጠቃላይ', icon: Shield },
    { id: 'users', labelEn: '2. Players & Wallets', labelAm: '2. ተጫዋቾች', icon: Users },
    { id: 'payouts', labelEn: '3. Payout & Withdraw', labelAm: '3. ወጪ ክፍያዎች', icon: Wallet },
    { id: 'deposits', labelEn: '4. Payment Verify', labelAm: '4. ክፍያ ማረጋገጫ', icon: ArrowDownCircle },
    { id: 'rooms', labelEn: '5. Game Rooms', labelAm: '5. የጨዋታ ክፍሎች', icon: LayoutGrid },
    { id: 'referrals', labelEn: '6. Referrals', labelAm: '6. ግብዣዎች', icon: Gift },
    { id: 'bot', labelEn: '7. Bot Manager', labelAm: '7. ቦት አስተዳደር', icon: Bot },
    { id: 'notifications', labelEn: '8. Notifications', labelAm: '8. ማሳወቂያዎች', icon: Bell },
    { id: 'settings', labelEn: '9. Audit & Security', labelAm: '9. ኦዲት እና ደህንነት', icon: Settings },
  ];

  const filteredDeposits = deposits.filter((dep) => {
    const q = depositSearchRef.trim().toLowerCase();
    if (!q) return true;
    return (
      dep.referenceCode.toLowerCase().includes(q) ||
      dep.depositId.toLowerCase().includes(q) ||
      dep.userDisplayName.toLowerCase().includes(q) ||
      dep.provider.toLowerCase().includes(q)
    );
  });

  return (
    <div
      data-testid="admin-dashboard"
      className="min-h-screen bg-[#FFF9ED] text-[#183326] pb-16"
    >
      {/* Top Admin Authority Bar (Unified ADEYBINGO Emerald, Gold & Clean White Theme) */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-[#E7EDE8] px-4 py-3 shadow-xs">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleExitAdmin}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#E6F6EB] border border-[#159447]/30 text-xs font-extrabold text-[#08743A] hover:border-[#159447] transition-colors"
            >
              <ArrowLeft size={14} />
              {lang === 'am' ? 'ወደ ጨዋታ ተመለስ' : 'Back to Player App'}
            </button>

            <div className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#159447] to-[#08743A] text-white flex items-center justify-center font-black shadow-sm">
                <Shield size={18} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326]">
                    ADEYBINGO Owner Admin Center
                  </h1>
                  <span className="px-2 py-0.5 rounded-md bg-[#FEF5DC] border border-[#F5BD42] text-[#9A6B0B] text-[10px] font-extrabold uppercase">
                    Owner Only
                  </span>
                </div>
                <p className="text-[11px] text-[#68776D]">
                  Payouts & Withdrawals · Payment Reference Verification · Protected by Server Allowlist
                </p>
              </div>
            </div>
          </div>

          {/* Authenticated Owner Badge & Refresh */}
          <div className="flex items-center gap-2">
            {actor && authStatus === 'authorized' && (
              <div className="px-3 py-1.5 rounded-xl bg-[#E6F6EB] border border-[#159447]/30 text-xs flex items-center gap-2">
                <CheckCircle2 size={14} className="text-[#159447]" />
                <span className="font-bold text-[#183326]">{actor.displayName}</span>
                {actor.email && (
                  <span className="font-mono text-[10px] text-[#08743A]">({actor.email})</span>
                )}
              </div>
            )}

            {authStatus === 'authorized' && (
              <button
                type="button"
                onClick={() => fetchAllAdminData(sessionToken, userSearchQuery, payoutFilter)}
                className="p-2 rounded-xl bg-white border border-[#E7EDE8] text-[#159447] hover:border-[#159447]"
                title="Refresh Server State"
              >
                <RefreshCw size={15} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Toast Notification */}
      {bannerToast && (
        <div className="max-w-7xl mx-auto px-4 mt-3">
          <div className="px-4 py-2.5 rounded-xl bg-white border-2 border-[#159447] text-[#183326] text-xs font-bold flex items-center justify-between shadow-md">
            <span className="flex items-center gap-2">
              <CheckCircle2 size={15} className="text-[#159447]" />
              {bannerToast}
            </span>
            <button
              type="button"
              onClick={() => setBannerToast(null)}
              className="text-xs underline text-[#68776D]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 pt-5">
        {/* HTTP 403 / 401 Server Guard Screen for Non-Admin Identities */}
        {authStatus === 'forbidden' && (
          <div
            data-testid="admin-access-denied"
            className="rounded-3xl bg-white border-2 border-[#D94B4B]/50 p-8 text-center max-w-xl mx-auto my-8 space-y-4 shadow-lg"
          >
            <div className="w-14 h-14 rounded-2xl bg-[#FFF5F5] text-[#D94B4B] flex items-center justify-center mx-auto border border-[#D94B4B]/30">
              <Lock size={28} />
            </div>
            <span className="inline-block px-3 py-1 rounded-md bg-[#FFF5F5] text-[#D94B4B] text-[11px] font-extrabold uppercase">
              HTTP 403 FORBIDDEN — OWNER ACCESS ONLY
            </span>
            <h2 className="font-['Outfit'] text-2xl font-extrabold text-[#183326]">
              Administrator Access Restricted
            </h2>
            <p className="text-xs text-[#68776D] leading-relaxed">{authMessage}</p>
            <div className="p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-left text-[11px] space-y-1 font-mono text-[#183326]">
              <div>Actor UID: {actor?.uid || 'unknown'}</div>
              <div>Email: {actor?.email || 'none'}</div>
              <div>Server Verified Role: {actor?.role || 'player'}</div>
              <div>Policy: Normal players cannot access Admin Management.</div>
            </div>
            <div className="flex flex-wrap justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleGoogleOwnerSignIn}
                disabled={googleSigningIn}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-xs font-extrabold flex items-center gap-1.5"
              >
                <LogIn size={14} />
                Sign in with Owner Google Account
              </button>
              <button
                type="button"
                onClick={() => setAuthStatus('unauthenticated')}
                className="px-4 py-2.5 rounded-xl bg-white border border-[#E7EDE8] text-[#183326] text-xs font-extrabold"
              >
                Provide Another Credential
              </button>
              <button
                type="button"
                onClick={handleExitAdmin}
                className="px-4 py-2.5 rounded-xl border border-[#E7EDE8] text-[#68776D] text-xs font-bold"
              >
                Return to Lobby
              </button>
            </div>
          </div>
        )}

        {authStatus === 'unauthenticated' && (
          <div
            data-testid="admin-auth-gate"
            className="rounded-3xl bg-white border border-[#E7EDE8] p-8 max-w-xl mx-auto my-8 space-y-5 shadow-lg"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-[#FEF5DC] border border-[#F5BD42] text-[#D99B20] flex items-center justify-center shrink-0">
                <Lock size={24} />
              </div>
              <div>
                <span className="inline-block px-2.5 py-0.5 rounded-md bg-[#E6F6EB] text-[#08743A] text-[10px] font-extrabold uppercase">
                  OWNER AUTHENTICATION GATE
                </span>
                <h2 className="font-['Outfit'] text-xl font-extrabold text-[#183326] mt-0.5">
                  Owner-Only Admin Management
                </h2>
              </div>
            </div>

            <p className="text-xs text-[#68776D] leading-relaxed">
              This panel is strictly locked to the game owner. Players cannot view or access Payouts,
              Withdrawals, or Payment Verification. Sign in with your authorized Google account or
              exchange a verified Telegram/Firebase token.
            </p>

            {/* One-Click Owner Access & Google Sign-In */}
            <div className="p-4 rounded-2xl bg-[#FFF9ED] border border-[#159447]/30 space-y-2.5">
              <div className="text-xs font-extrabold text-[#08743A] flex items-center gap-1.5">
                <Shield size={14} className="text-[#159447]" />
                Owner Quick Unlock (abiwolfcode@gmail.com)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  data-testid="owner-quick-unlock-btn"
                  onClick={handleOwnerQuickUnlock}
                  disabled={googleSigningIn}
                  className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#F5BD42] to-[#D99B20] text-[#183326] text-xs font-extrabold flex items-center justify-center gap-2 shadow-sm hover:brightness-105 disabled:opacity-50"
                >
                  <Shield size={15} />
                  {googleSigningIn ? 'Unlocking...' : 'Open Owner Dashboard Now'}
                </button>
                <button
                  type="button"
                  onClick={handleGoogleOwnerSignIn}
                  disabled={googleSigningIn}
                  className="w-full py-3 px-4 rounded-xl bg-white border border-[#159447]/40 text-[#08743A] text-xs font-extrabold flex items-center justify-center gap-2 hover:border-[#159447] disabled:opacity-50"
                >
                  <LogIn size={15} />
                  Sign In with Google Popup
                </button>
              </div>
            </div>

            {authMessage && (
              <div
                data-testid="admin-auth-error"
                className="p-3 rounded-xl bg-[#FFF5F5] border border-[#D94B4B]/40 text-xs text-[#D94B4B] font-semibold"
              >
                {authMessage}
              </div>
            )}

            <div className="space-y-2 pt-2 border-t border-[#E7EDE8]">
              <label className="block text-[11px] font-extrabold text-[#183326]">
                Or Paste Telegram WebApp initData / Firebase ID Token / Session Token
              </label>
              <textarea
                data-testid="admin-token-input"
                rows={3}
                value={rawTokenInput}
                onChange={(e) => setRawTokenInput(e.target.value)}
                placeholder="Paste signed Telegram initData (user=...&hash=...) or Bearer token..."
                className="w-full px-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-mono text-[#183326] placeholder:text-[#68776D] focus:outline-none focus:border-[#159447]"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="admin-authenticate-btn"
                onClick={() => authenticateWithCredential(rawTokenInput)}
                className="px-5 py-2.5 rounded-xl bg-[#159447] text-white text-xs font-extrabold hover:bg-[#08743A] transition-all"
              >
                Verify & Authenticate Session
              </button>
              <button
                type="button"
                onClick={handleExitAdmin}
                className="px-4 py-2.5 rounded-xl border border-[#E7EDE8] bg-white text-[#183326] text-xs font-bold"
              >
                Back to Game Lobby
              </button>
            </div>
          </div>
        )}

        {authStatus === 'authorized' && (
          <div className="space-y-5">
            {/* 9-Section Navigation Strip (Mobile-First Touch Scroll) */}
            <nav
              aria-label="Admin sections"
              className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-2 border-b border-[#E7EDE8]"
            >
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`admin-tab-${item.id}`}
                    onClick={() => setActiveTab(item.id)}
                    className={`px-3.5 py-2 min-h-[40px] rounded-xl text-xs font-extrabold whitespace-nowrap flex items-center gap-1.5 transition-all shrink-0 ${
                      active
                        ? 'bg-[#159447] text-white shadow-[0_4px_12px_rgba(21,148,71,0.28)]'
                        : 'bg-white border border-[#E7EDE8] text-[#68776D] hover:border-[#159447]/50 hover:text-[#183326]'
                    }`}
                  >
                    <Icon size={14} />
                    {lang === 'am' ? item.labelAm : item.labelEn}
                  </button>
                );
              })}
            </nav>

            {/* SECTION 1: OVERVIEW */}
            {activeTab === 'overview' && overview && (
              <section data-testid="admin-overview-section" className="space-y-4 sm:space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="p-4 rounded-2xl bg-white border border-[#E7EDE8] shadow-xs">
                    <span className="text-[11px] font-bold text-[#68776D] uppercase">
                      Total Players
                    </span>
                    <b className="block font-['Outfit'] text-2xl font-extrabold text-[#183326] mt-1">
                      {overview.totalUsers}
                    </b>
                    <span className="text-[11px] text-[#159447] font-semibold">
                      {overview.activeUsers} active · {overview.suspendedUsers} suspended
                    </span>
                  </div>

                  <div
                    onClick={() => setActiveTab('payouts')}
                    className="p-4 rounded-2xl bg-white border border-[#F5BD42] cursor-pointer hover:border-[#D99B20] transition-colors shadow-xs"
                  >
                    <span className="text-[11px] font-bold text-[#9A6B0B] uppercase">
                      Player Withdrawals / Payouts
                    </span>
                    <b className="block font-['Outfit'] text-2xl font-extrabold text-[#D99B20] mt-1">
                      {overview.payoutCounts.Pending + overview.payoutCounts['Under Review']} Pending
                    </b>
                    <span className="text-[11px] text-[#68776D]">
                      {overview.payoutCounts.Completed} completed · {overview.payoutCounts.total} total
                    </span>
                  </div>

                  <div
                    onClick={() => setActiveTab('deposits')}
                    className="p-4 rounded-2xl bg-white border border-[#159447]/40 cursor-pointer hover:border-[#159447] transition-colors shadow-xs"
                  >
                    <span className="text-[11px] font-bold text-[#08743A] uppercase">
                      Payment Verifications
                    </span>
                    <b className="block font-['Outfit'] text-2xl font-extrabold text-[#159447] mt-1">
                      {overview.depositCounts.Pending} Awaiting Verify
                    </b>
                    <span className="text-[11px] text-[#68776D]">
                      {overview.depositCounts.Approved} verified & credited
                    </span>
                  </div>

                  <div className="p-4 rounded-2xl bg-white border border-[#E7EDE8] shadow-xs">
                    <span className="text-[11px] font-bold text-[#68776D] uppercase">
                      SHA-256 Audit Chain
                    </span>
                    <b className="block font-['Outfit'] text-2xl font-extrabold text-[#168A49] mt-1">
                      {overview.auditIntegrity.valid ? 'Verified' : 'Tampered'}
                    </b>
                    <span className="text-[11px] text-[#68776D]">
                      {overview.auditTrailEntries} immutable log entries
                    </span>
                  </div>
                </div>

                {/* Quick Owner Action Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="rounded-2xl bg-white border border-[#E7EDE8] p-5 space-y-2 shadow-xs">
                    <div className="flex items-center justify-between">
                      <h3 className="font-['Outfit'] text-base font-extrabold text-[#183326]">
                        Payment Verification Queue
                      </h3>
                      <ArrowDownCircle size={18} className="text-[#159447]" />
                    </div>
                    <p className="text-xs text-[#68776D]">
                      Inspect Telebirr, CBE Birr, and Chapa reference codes and credit verified
                      player balances in one click.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('deposits')}
                      className="px-4 py-2 rounded-xl bg-[#159447] text-white text-xs font-extrabold"
                    >
                      Open Payment Verification ({overview.depositCounts.Pending})
                    </button>
                  </div>

                  <div className="rounded-2xl bg-white border border-[#E7EDE8] p-5 space-y-2 shadow-xs">
                    <div className="flex items-center justify-between">
                      <h3 className="font-['Outfit'] text-base font-extrabold text-[#183326]">
                        Players Payout & Withdrawals
                      </h3>
                      <Wallet size={18} className="text-[#D99B20]" />
                    </div>
                    <p className="text-xs text-[#68776D]">
                      Review player withdrawal requests, verify destination numbers, mark payouts
                      Completed, or Reject & auto-refund.
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('payouts')}
                      className="px-4 py-2 rounded-xl bg-[#F5BD42] text-[#183326] text-xs font-extrabold"
                    >
                      Manage Withdrawals ({overview.payoutCounts.Pending})
                    </button>
                  </div>

                  <div className="rounded-2xl bg-white border border-[#E7EDE8] p-5 space-y-2 shadow-xs">
                    <div className="flex items-center justify-between">
                      <h3 className="font-['Outfit'] text-base font-extrabold text-[#183326]">
                        Player Wallets & Round Control
                      </h3>
                      <Users size={18} className="text-[#159447]" />
                    </div>
                    <p className="text-xs text-[#68776D]">
                      Directly credit/debit player balances, inspect transaction ledgers, or force
                      start/reset live Bingo rounds.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveTab('users')}
                        className="px-3.5 py-2 rounded-xl bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] text-xs font-extrabold"
                      >
                        Manage Players
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveTab('rooms')}
                        className="px-3.5 py-2 rounded-xl bg-[#FEF5DC] border border-[#F5BD42] text-[#9A6B0B] text-xs font-extrabold"
                      >
                        Live Rooms
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* SECTION 2: USER MANAGEMENT & DIRECT WALLET CREDIT/DEBIT */}
            {activeTab === 'users' && (
              <section data-testid="admin-users-section" className="space-y-4">
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-4 flex flex-wrap items-center justify-between gap-3 shadow-xs">
                  <div>
                    <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                      Players, Wallet Adjustment & Account Status
                    </h2>
                    <p className="text-xs text-[#68776D]">
                      Search players, credit/debit ETB balances directly, inspect wallet ledgers, or
                      suspend/reactivate accounts.
                    </p>
                  </div>

                  <div className="relative w-full sm:w-72">
                    <Search
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-[#68776D]"
                    />
                    <input
                      type="text"
                      data-testid="admin-user-search"
                      value={userSearchQuery}
                      onChange={(e) => setUserSearchQuery(e.target.value)}
                      placeholder="Search name, @handle, Telegram ID..."
                      className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326] placeholder:text-[#68776D] focus:outline-none focus:border-[#159447]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  {users.map((u) => (
                    <div
                      key={u.uid}
                      data-testid={`admin-user-row-${u.uid}`}
                      className="rounded-2xl bg-white border border-[#E7EDE8] p-4 space-y-3 shadow-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <b className="text-sm font-extrabold text-[#183326]">{u.displayName}</b>
                            <span className="text-xs font-mono text-[#68776D]">@{u.username}</span>
                            <span
                              className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase ${
                                u.role === 'admin'
                                  ? 'bg-[#E6F6EB] text-[#08743A] border border-[#159447]/40'
                                  : 'bg-[#FFF9ED] text-[#68776D] border border-[#E7EDE8]'
                              }`}
                            >
                              {u.role}
                            </span>
                            <span
                              data-testid={`admin-user-status-${u.uid}`}
                              className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase ${
                                u.accountStatus === 'active'
                                  ? 'bg-[#E6F6EB] text-[#168A49]'
                                  : 'bg-[#FFF5F5] text-[#D94B4B]'
                              }`}
                            >
                              {u.accountStatus}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-[#68776D]">
                            <span>TG ID: #{u.telegramUserId}</span>
                            <span>·</span>
                            <span>
                              Phone: <b className="text-[#183326]">{u.maskedPhone}</b>{' '}
                              {u.phoneVerified ? '✓' : '(Unverified)'}
                            </span>
                            <span>·</span>
                            <span>
                              Balance:{' '}
                              <b className="text-[#08743A] font-mono">
                                {u.demoBalanceEtb.toFixed(2)} ETB
                              </b>
                            </span>
                            <span>·</span>
                            <span>
                              Games: {u.gamesPlayed} ({u.gamesWon} won)
                            </span>
                          </div>
                          {u.suspensionReason && (
                            <p className="text-[11px] text-[#D94B4B] font-semibold">
                              Suspension Note: {u.suspensionReason}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedUserLedger(
                                selectedUserLedger?.uid === u.uid ? null : u
                              )
                            }
                            className="px-3 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-bold text-[#08743A] hover:border-[#159447]"
                          >
                            {selectedUserLedger?.uid === u.uid
                              ? 'Hide Ledger'
                              : `Wallet Ledger (${u.walletLedger.length})`}
                          </button>

                          {u.uid !== actor?.uid && (
                            <div className="flex flex-wrap items-center gap-1.5 w-full sm:w-auto">
                              <input
                                type="text"
                                placeholder="Reason for status change..."
                                value={suspensionReasonDraft[u.uid] || ''}
                                onChange={(e) =>
                                  setSuspensionReasonDraft((prev) => ({
                                    ...prev,
                                    [u.uid]: e.target.value,
                                  }))
                                }
                                className="flex-1 sm:w-40 px-2.5 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326] min-h-[38px]"
                              />
                              <button
                                type="button"
                                data-testid={`admin-user-toggle-${u.uid}`}
                                onClick={() => handleToggleUserStatus(u)}
                                className={`px-3 py-2 min-h-[38px] rounded-xl text-xs font-extrabold flex items-center gap-1 ${
                                  u.accountStatus === 'active'
                                    ? 'bg-[#FFF5F5] border border-[#D94B4B]/40 text-[#D94B4B] hover:bg-[#D94B4B]/10'
                                    : 'bg-[#E6F6EB] border border-[#159447]/40 text-[#08743A] hover:bg-[#159447]/20'
                                }`}
                              >
                                {u.accountStatus === 'active' ? (
                                  <>
                                    <Ban size={13} /> Suspend
                                  </>
                                ) : (
                                  <>
                                    <UserCheck size={13} /> Reactivate
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Direct Owner Wallet Credit / Payout Debit Controls (Mobile-First) */}
                      <div className="pt-2.5 border-t border-[#E7EDE8] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <span className="text-[11px] font-bold text-[#68776D]">
                          Direct Wallet Adjustment (Credit / Payout Debit):
                        </span>
                        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                          <input
                            type="number"
                            min={1}
                            max={50000}
                            placeholder="ETB Amount (e.g. 50)"
                            value={walletDeltaDraft[u.uid] ?? '50'}
                            onChange={(e) =>
                              setWalletDeltaDraft((prev) => ({
                                ...prev,
                                [u.uid]: e.target.value,
                              }))
                            }
                            className="w-24 sm:w-28 px-2.5 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-mono text-[#183326] min-h-[38px]"
                          />
                          <input
                            type="text"
                            placeholder="Verification note / payout ref..."
                            value={walletReasonDraft[u.uid] || ''}
                            onChange={(e) =>
                              setWalletReasonDraft((prev) => ({
                                ...prev,
                                [u.uid]: e.target.value,
                              }))
                            }
                            className="flex-1 min-w-[140px] sm:w-48 px-2.5 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326] min-h-[38px]"
                          />
                          <button
                            type="button"
                            onClick={() => handleAdjustUserBalance(u, 1)}
                            className="flex-1 sm:flex-initial justify-center px-3 py-2 min-h-[38px] rounded-xl bg-[#E6F6EB] border border-[#159447]/40 text-[#08743A] font-extrabold flex items-center gap-1 hover:bg-[#159447]/20"
                          >
                            <PlusCircle size={13} /> +Credit ETB
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAdjustUserBalance(u, -1)}
                            className="flex-1 sm:flex-initial justify-center px-3 py-2 min-h-[38px] rounded-xl bg-[#FEF5DC] border border-[#F5BD42] text-[#9A6B0B] font-extrabold flex items-center gap-1 hover:bg-[#F5BD42]/40"
                          >
                            <MinusCircle size={13} /> -Debit / Payout
                          </button>
                        </div>
                      </div>

                      {selectedUserLedger?.uid === u.uid && (
                        <div className="pt-3 border-t border-[#E7EDE8]">
                          <h4 className="text-xs font-extrabold text-[#08743A] mb-2">
                            Wallet Ledger History — {u.displayName}
                          </h4>
                          {u.walletLedger.length === 0 ? (
                            <p className="text-xs text-[#68776D]">No ledger entries recorded.</p>
                          ) : (
                            <div className="space-y-1.5">
                              {u.walletLedger.map((tx) => (
                                <div
                                  key={tx.id}
                                  className="flex items-center justify-between text-xs px-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8]"
                                >
                                  <div>
                                    <b className="font-bold text-[#183326]">{tx.description}</b>
                                    <span className="block text-[10px] font-mono text-[#68776D]">
                                      Ref: {tx.reference} · {tx.timestamp}
                                    </span>
                                  </div>
                                  <span
                                    className={`font-mono font-extrabold ${
                                      tx.amountEtb >= 0 ? 'text-[#168A49]' : 'text-[#D94B4B]'
                                    }`}
                                  >
                                    {tx.amountEtb >= 0 ? `+${tx.amountEtb}` : tx.amountEtb} ETB
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* SECTION 3: PLAYERS PAYOUT & WITHDRAWAL MANAGEMENT */}
            {activeTab === 'payouts' && (
              <section data-testid="admin-payouts-section" className="space-y-4">
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-4 flex flex-wrap items-center justify-between gap-3 shadow-xs">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                        Players Payout & Withdrawal Management
                      </h2>
                      <span className="px-2.5 py-0.5 rounded-md bg-[#FEF5DC] border border-[#F5BD42] text-[#9A6B0B] text-[10px] font-extrabold uppercase">
                        Withdrawal Queue
                      </span>
                    </div>
                    <p className="text-xs text-[#68776D]">
                      Approve, complete, or reject player withdrawal requests. Rejecting a withdrawal
                      automatically refunds the player’s ETB balance.
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {['ALL', 'Pending', 'Under Review', 'Approved', 'Completed', 'Rejected'].map(
                      (st) => (
                        <button
                          key={st}
                          type="button"
                          onClick={() => setPayoutFilter(st)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${
                            payoutFilter === st
                              ? 'bg-[#F5BD42] text-[#183326]'
                              : 'bg-[#FFF9ED] border border-[#E7EDE8] text-[#68776D]'
                          }`}
                        >
                          {st}
                        </button>
                      )
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  {payouts.map((order) => (
                    <div
                      key={order.requestId}
                      data-testid={`admin-payout-row-${order.requestId}`}
                      className="rounded-2xl bg-white border border-[#E7EDE8] p-4 space-y-3 shadow-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs font-extrabold text-[#08743A]">
                              {order.requestId}
                            </span>
                            <b className="text-sm font-extrabold text-[#183326]">
                              {order.userDisplayName}
                            </b>
                            <span className="text-xs text-[#68776D]">
                              (TG #{order.telegramUserId})
                            </span>
                            <span
                              data-testid={`admin-payout-status-${order.requestId}`}
                              className={`px-2.5 py-0.5 rounded-md text-[10px] font-extrabold uppercase ${
                                order.status === 'Completed' || order.status === 'Approved'
                                  ? 'bg-[#E6F6EB] text-[#168A49] border border-[#159447]/40'
                                  : order.status === 'Rejected'
                                    ? 'bg-[#FFF5F5] text-[#D94B4B] border border-[#D94B4B]/40'
                                    : 'bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42]'
                              }`}
                            >
                              {order.status}
                            </span>
                          </div>
                          <div className="text-xs text-[#68776D] mt-1">
                            Withdrawal Amount:{' '}
                            <b className="text-[#D99B20] font-mono">
                              {order.requestedAmountEtb.toFixed(2)} ETB
                            </b>{' '}
                            · Method: <b className="text-[#183326]">{order.paymentMethod}</b> ·
                            Destination: <b className="text-[#08743A]">{order.destinationMasked}</b>{' '}
                            · Requested: {order.requestDate}
                          </div>
                        </div>

                        {/* Quick One-Click Payout Actions + Status Selector (Mobile-First) */}
                        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                          {order.status !== 'Completed' && order.status !== 'Rejected' && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleUpdatePayoutStatus(order, 'Approved')}
                                className="px-3 py-2 min-h-[38px] rounded-xl bg-[#E6F6EB] border border-[#159447]/40 text-[#08743A] text-xs font-extrabold hover:bg-[#159447]/20"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => handleUpdatePayoutStatus(order, 'Completed')}
                                className="px-3 py-2 min-h-[38px] rounded-xl bg-[#159447] text-white text-xs font-extrabold hover:bg-[#08743A]"
                              >
                                Mark Paid / Completed
                              </button>
                              <button
                                type="button"
                                onClick={() => handleUpdatePayoutStatus(order, 'Rejected')}
                                className="px-3 py-2 min-h-[38px] rounded-xl bg-[#FFF5F5] border border-[#D94B4B]/40 text-[#D94B4B] text-xs font-extrabold hover:bg-[#D94B4B]/10"
                              >
                                Reject & Refund
                              </button>
                            </>
                          )}

                          <select
                            aria-label={`Status for ${order.requestId}`}
                            data-testid={`admin-payout-select-${order.requestId}`}
                            value={payoutStatusDraft[order.requestId] || order.status}
                            onChange={(e) =>
                              setPayoutStatusDraft((prev) => ({
                                ...prev,
                                [order.requestId]: e.target.value as AdminPayoutOrder['status'],
                              }))
                            }
                            className="px-3 py-2 min-h-[38px] rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-bold text-[#183326]"
                          >
                            <option value="Pending">Pending</option>
                            <option value="Under Review">Under Review</option>
                            <option value="Approved">Approved</option>
                            <option value="Rejected">Rejected</option>
                            <option value="Completed">Completed</option>
                          </select>

                          <input
                            type="text"
                            data-testid={`admin-payout-notes-${order.requestId}`}
                            value={payoutNotesDraft[order.requestId] ?? order.reviewNotes}
                            onChange={(e) =>
                              setPayoutNotesDraft((prev) => ({
                                ...prev,
                                [order.requestId]: e.target.value,
                              }))
                            }
                            placeholder="Payout transfer ref / review notes..."
                            className="flex-1 min-w-[150px] sm:w-52 px-3 py-2 min-h-[38px] rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326]"
                          />

                          <button
                            type="button"
                            data-testid={`admin-payout-save-${order.requestId}`}
                            onClick={() => handleUpdatePayoutStatus(order)}
                            className="w-full sm:w-auto px-3.5 py-2 min-h-[38px] rounded-xl bg-[#159447] text-white text-xs font-extrabold hover:bg-[#08743A]"
                          >
                            Update Status
                          </button>
                        </div>
                      </div>

                      <div className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[11px] space-y-1">
                        <div className="font-bold text-[#183326]">
                          Review Notes:{' '}
                          <span className="font-normal text-[#68776D]">{order.reviewNotes}</span>
                          {order.reviewedBy && (
                            <span className="ml-2 text-[#08743A]">
                              (Reviewed by {order.reviewedBy})
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {order.auditTrail.map((tr, i) => (
                            <span
                              key={i}
                              className="px-2 py-0.5 rounded bg-white border border-[#E7EDE8] font-mono text-[10px] text-[#68776D]"
                            >
                              {tr.fromStatus} → {tr.toStatus} ({tr.reviewedBy})
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* SECTION 4: PAYMENT VERIFICATION & DEPOSIT REQUESTS */}
            {activeTab === 'deposits' && (
              <section data-testid="admin-deposits-section" className="space-y-4">
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-4 flex flex-wrap items-center justify-between gap-3 shadow-xs">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                        Payment Verification & Deposit Approval
                      </h2>
                      <span className="px-2.5 py-0.5 rounded-md bg-[#E6F6EB] border border-[#159447]/40 text-[#08743A] text-[10px] font-extrabold uppercase">
                        Reference Check
                      </span>
                    </div>
                    <p className="text-xs text-[#68776D]">
                      Verify player Telebirr, CBE Birr, or Chapa transaction reference codes.
                      Approving a deposit immediately credits the player’s wallet balance.
                    </p>
                  </div>

                  <div className="relative w-full sm:w-72">
                    <Search
                      size={15}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-[#68776D]"
                    />
                    <input
                      type="text"
                      value={depositSearchRef}
                      onChange={(e) => setDepositSearchRef(e.target.value)}
                      placeholder="Verify Reference Code (e.g. REF-...)"
                      className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-mono text-[#183326] placeholder:text-[#68776D] focus:outline-none focus:border-[#159447]"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  {filteredDeposits.map((dep) => (
                    <div
                      key={dep.depositId}
                      data-testid={`admin-deposit-row-${dep.depositId}`}
                      className="rounded-2xl bg-white border border-[#E7EDE8] p-4 flex flex-wrap items-center justify-between gap-3 shadow-xs"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-extrabold text-[#08743A]">
                            {dep.depositId}
                          </span>
                          <b className="text-sm font-extrabold text-[#183326]">{dep.userDisplayName}</b>
                          <span className="px-2 py-0.5 rounded bg-[#FEF5DC] border border-[#F5BD42] font-mono text-xs font-bold text-[#9A6B0B]">
                            Ref: {dep.referenceCode}
                          </span>
                          <span
                            data-testid={`admin-deposit-status-${dep.depositId}`}
                            className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase ${
                              dep.status === 'Approved'
                                ? 'bg-[#E6F6EB] text-[#168A49] border border-[#159447]/40'
                                : dep.status === 'Rejected'
                                  ? 'bg-[#FFF5F5] text-[#D94B4B] border border-[#D94B4B]/40'
                                  : 'bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42]'
                            }`}
                          >
                            {dep.status}
                          </span>
                        </div>
                        <div className="text-xs text-[#68776D]">
                          Amount:{' '}
                          <b className="text-[#168A49] font-mono">
                            +{dep.amountEtb.toFixed(2)} ETB
                          </b>{' '}
                          · Provider: <b className="text-[#183326]">{dep.provider}</b> · Submitted:{' '}
                          {dep.requestDate}
                        </div>
                        <div className="text-[11px] text-[#68776D]">
                          Verification Note: {dep.reviewNotes}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                        <input
                          type="text"
                          value={depositNotesDraft[dep.depositId] ?? dep.reviewNotes}
                          onChange={(e) =>
                            setDepositNotesDraft((prev) => ({
                              ...prev,
                              [dep.depositId]: e.target.value,
                            }))
                          }
                          placeholder="Verification note..."
                          className="w-full sm:w-48 px-3 py-2 min-h-[38px] rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326]"
                        />
                        <button
                          type="button"
                          data-testid={`admin-deposit-approve-${dep.depositId}`}
                          disabled={dep.status !== 'Pending'}
                          onClick={() => handleReviewDeposit(dep, 'Approved')}
                          className="flex-1 sm:flex-initial justify-center px-3.5 py-2 min-h-[38px] rounded-xl bg-[#159447] text-white text-xs font-extrabold disabled:opacity-40 flex items-center gap-1 hover:bg-[#08743A]"
                        >
                          <CheckCircle2 size={13} /> Verify & Approve
                        </button>
                        <button
                          type="button"
                          data-testid={`admin-deposit-reject-${dep.depositId}`}
                          disabled={dep.status !== 'Pending'}
                          onClick={() => handleReviewDeposit(dep, 'Rejected')}
                          className="flex-1 sm:flex-initial justify-center px-3 py-2 min-h-[38px] rounded-xl bg-[#FFF5F5] border border-[#D94B4B]/40 text-[#D94B4B] text-xs font-extrabold disabled:opacity-40 flex items-center gap-1 hover:bg-[#D94B4B]/10"
                        >
                          <XCircle size={13} /> Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* SECTION 5: GAME ROOM MANAGEMENT & LIVE ROUND CONTROL */}
            {activeTab === 'rooms' && (
              <section data-testid="admin-rooms-section" className="space-y-4">
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-4 shadow-xs">
                  <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                    Game Room Configuration & Live Round Control
                  </h2>
                  <p className="text-xs text-[#68776D]">
                    Configure entry card price (ETB), 60-second countdown duration, minimum players,
                    room status, or force-start / reset a live round.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {rooms.map((room) => {
                    const draft = roomDrafts[room.id] || {
                      cardPriceEtb: room.cardPriceEtb,
                      lobbyCountdownSeconds: room.lobbyCountdownSeconds,
                      minPlayers: room.minPlayers,
                      status: room.status,
                    };
                    return (
                      <div
                        key={room.id}
                        data-testid={`admin-room-card-${room.id}`}
                        className="rounded-2xl bg-white border border-[#E7EDE8] p-4 space-y-3 shadow-xs"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <b className="text-sm font-extrabold text-[#183326] block">{room.nameEn}</b>
                            <span className="text-xs text-[#08743A]">{room.nameAm}</span>
                          </div>
                          <span className="px-2 py-0.5 rounded-md bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] text-[10px] font-extrabold uppercase">
                            {room.status}
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <label className="space-y-1">
                            <span className="text-[11px] font-bold text-[#68776D]">
                              Card Price (ETB)
                            </span>
                            <input
                              type="number"
                              data-testid={`admin-room-price-${room.id}`}
                              value={draft.cardPriceEtb}
                              onChange={(e) =>
                                setRoomDrafts((prev) => ({
                                  ...prev,
                                  [room.id]: {
                                    ...draft,
                                    cardPriceEtb: Number(e.target.value),
                                  },
                                }))
                              }
                              className="w-full px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] font-mono text-[#183326]"
                            />
                          </label>

                          <label className="space-y-1">
                            <span className="text-[11px] font-bold text-[#68776D]">
                              Countdown (sec)
                            </span>
                            <input
                              type="number"
                              data-testid={`admin-room-countdown-${room.id}`}
                              value={draft.lobbyCountdownSeconds}
                              onChange={(e) =>
                                setRoomDrafts((prev) => ({
                                  ...prev,
                                  [room.id]: {
                                    ...draft,
                                    lobbyCountdownSeconds: Number(e.target.value),
                                  },
                                }))
                              }
                              className="w-full px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] font-mono text-[#183326]"
                            />
                          </label>

                          <label className="space-y-1">
                            <span className="text-[11px] font-bold text-[#68776D]">
                              Min Players
                            </span>
                            <input
                              type="number"
                              value={draft.minPlayers}
                              onChange={(e) =>
                                setRoomDrafts((prev) => ({
                                  ...prev,
                                  [room.id]: {
                                    ...draft,
                                    minPlayers: Number(e.target.value),
                                  },
                                }))
                              }
                              className="w-full px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] font-mono text-[#183326]"
                            />
                          </label>

                          <label className="space-y-1">
                            <span className="text-[11px] font-bold text-[#68776D]">Status</span>
                            <select
                              value={draft.status}
                              onChange={(e) =>
                                setRoomDrafts((prev) => ({
                                  ...prev,
                                  [room.id]: {
                                    ...draft,
                                    status: e.target.value as AdminRoomRecord['status'],
                                  },
                                }))
                              }
                              className="w-full px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] font-bold text-[#183326]"
                            >
                              <option value="open">open</option>
                              <option value="starting">starting</option>
                              <option value="live">live</option>
                              <option value="maintenance">maintenance</option>
                            </select>
                          </label>
                        </div>

                        <button
                          type="button"
                          data-testid={`admin-room-save-${room.id}`}
                          onClick={() => handleSaveRoom(room.id)}
                          className="w-full py-2 rounded-xl bg-[#159447] text-white text-xs font-extrabold hover:bg-[#08743A]"
                        >
                          Save Room Config
                        </button>

                        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#E7EDE8]">
                          <button
                            type="button"
                            onClick={() => handleRoomRoundAction(room.id, 'force_start')}
                            className="py-1.5 px-2 rounded-xl bg-[#FEF5DC] border border-[#F5BD42] text-[#9A6B0B] text-[11px] font-extrabold flex items-center justify-center gap-1 hover:bg-[#F5BD42]/40"
                          >
                            <Play size={12} /> Force Start
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRoomRoundAction(room.id, 'reset')}
                            className="py-1.5 px-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326] text-[11px] font-extrabold flex items-center justify-center gap-1 hover:border-[#159447]"
                          >
                            <RotateCcw size={12} /> Reset Round
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* SECTION 6: REFERRAL MANAGEMENT */}
            {activeTab === 'referrals' && (
              <section data-testid="admin-referrals-section" className="space-y-4">
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-4 shadow-xs">
                  <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                    Referral Program & Bonus Tracking
                  </h2>
                  <p className="text-xs text-[#68776D]">
                    Inspect inviter-to-invitee referral links, verification status, and Demo ETB
                    bonuses.
                  </p>
                </div>

                <div className="space-y-2.5">
                  {referrals.map((ref) => (
                    <div
                      key={ref.id}
                      className="rounded-2xl bg-white border border-[#E7EDE8] p-4 flex flex-wrap items-center justify-between gap-3 shadow-xs"
                    >
                      <div>
                        <b className="text-xs font-extrabold text-[#183326]">
                          {ref.inviterName} (TG #{ref.inviterTelegramId}) invited {ref.inviteeName} (
                          {ref.inviteeHandle})
                        </b>
                        <span className="block text-[11px] text-[#68776D]">
                          Joined: {ref.joinedAt} · Inviter Bonus: +{ref.inviterBonusEtb} ETB ·
                          Invitee Bonus: +{ref.inviteeBonusEtb} ETB
                        </span>
                      </div>
                      <span
                        className={`px-2.5 py-1 rounded-md text-[10px] font-extrabold uppercase ${
                          ref.status === 'qualified'
                            ? 'bg-[#E6F6EB] text-[#168A49]'
                            : 'bg-[#FEF5DC] text-[#9A6B0B]'
                        }`}
                      >
                        {ref.status}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* SECTION 7: BOT MANAGEMENT */}
            {activeTab === 'bot' && botConfig && (
              <section data-testid="admin-bot-section" className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Welcome Message & Button Labels */}
                  <div className="rounded-2xl bg-white border border-[#E7EDE8] p-5 space-y-3 shadow-xs">
                    <h3 className="font-['Outfit'] text-base font-extrabold text-[#183326]">
                      Telegram Bot Welcome Message & Menu Labels
                    </h3>
                    <p className="text-xs text-[#68776D]">
                      Customize the bilingual `/start` welcome text and WebApp launch button labels
                      served by the Telegram bot.
                    </p>

                    <label className="block space-y-1 text-xs">
                      <span className="font-bold text-[#183326]">
                        Custom Amharic Welcome (Optional)
                      </span>
                      <textarea
                        rows={2}
                        data-testid="admin-bot-welcome-am"
                        value={botWelcomeAmDraft}
                        onChange={(e) => setBotWelcomeAmDraft(e.target.value)}
                        placeholder="Leave blank for default Amharic greeting..."
                        className="w-full px-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326]"
                      />
                    </label>

                    <label className="block space-y-1 text-xs">
                      <span className="font-bold text-[#183326]">
                        Custom English Welcome (Optional)
                      </span>
                      <textarea
                        rows={2}
                        data-testid="admin-bot-welcome-en"
                        value={botWelcomeEnDraft}
                        onChange={(e) => setBotWelcomeEnDraft(e.target.value)}
                        placeholder="Leave blank for default English greeting..."
                        className="w-full px-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326]"
                      />
                    </label>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <label className="space-y-1">
                        <span className="font-bold text-[#183326]">Play Button (AM)</span>
                        <input
                          type="text"
                          value={botPlayLabelAmDraft}
                          onChange={(e) => setBotPlayLabelAmDraft(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326]"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="font-bold text-[#183326]">Play Button (EN)</span>
                        <input
                          type="text"
                          value={botPlayLabelEnDraft}
                          onChange={(e) => setBotPlayLabelEnDraft(e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326]"
                        />
                      </label>
                    </div>

                    <button
                      type="button"
                      data-testid="admin-bot-save-btn"
                      onClick={handleSaveBotConfig}
                      className="px-4 py-2 rounded-xl bg-[#159447] text-white text-xs font-extrabold"
                    >
                      Save Bot Configuration
                    </button>
                  </div>

                  {/* Broadcast Announcement */}
                  <div className="rounded-2xl bg-white border border-[#E7EDE8] p-5 space-y-3 shadow-xs">
                    <h3 className="font-['Outfit'] text-base font-extrabold text-[#183326]">
                      Broadcast Bot Announcement
                    </h3>
                    <p className="text-xs text-[#68776D]">
                      Send a bilingual announcement to registered Telegram players who have
                      notifications enabled.
                    </p>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <input
                        type="text"
                        value={announceTitleAm}
                        onChange={(e) => setAnnounceTitleAm(e.target.value)}
                        placeholder="Title (Amharic)"
                        className="px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326]"
                      />
                      <input
                        type="text"
                        value={announceTitleEn}
                        onChange={(e) => setAnnounceTitleEn(e.target.value)}
                        placeholder="Title (English)"
                        className="px-2.5 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326]"
                      />
                    </div>

                    <textarea
                      rows={2}
                      data-testid="admin-bot-announce-body-en"
                      value={announceBodyEn}
                      onChange={(e) => setAnnounceBodyEn(e.target.value)}
                      placeholder="Announcement message (English)..."
                      className="w-full px-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326]"
                    />

                    <textarea
                      rows={2}
                      data-testid="admin-bot-announce-body-am"
                      value={announceBodyAm}
                      onChange={(e) => setAnnounceBodyAm(e.target.value)}
                      placeholder="የማስታወቂያ መልዕክት (አማርኛ)..."
                      className="w-full px-3 py-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs text-[#183326]"
                    />

                    <div className="flex items-center justify-between gap-2">
                      <select
                        value={announceAudience}
                        onChange={(e) =>
                          setAnnounceAudience(
                            e.target.value as 'all_players' | 'verified_players'
                          )
                        }
                        className="px-3 py-1.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-bold text-[#183326]"
                      >
                        <option value="all_players">All Opted-In Players</option>
                        <option value="verified_players">Verified Phone Players Only</option>
                      </select>

                      <button
                        type="button"
                        data-testid="admin-bot-announce-btn"
                        onClick={handleSendAnnouncement}
                        className="px-4 py-2 rounded-xl bg-[#F5BD42] text-[#183326] text-xs font-extrabold flex items-center gap-1.5"
                      >
                        <Send size={13} /> Broadcast Now
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* SECTION 8: NOTIFICATIONS MANAGEMENT */}
            {activeTab === 'notifications' && (
              <section data-testid="admin-notifications-section" className="space-y-4">
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-4 flex flex-wrap items-center justify-between gap-3 shadow-xs">
                  <div>
                    <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                      Bot Notification Outbox & Support Dispatch
                    </h2>
                    <p className="text-xs text-[#68776D]">
                      Real-time delivery log for game starts, called numbers, winners, referral
                      rewards, and support responses.
                    </p>
                  </div>

                  <button
                    type="button"
                    data-testid="admin-send-support-notif-btn"
                    onClick={handleSendTestSupportNotification}
                    className="px-4 py-2 rounded-xl bg-[#159447] text-white text-xs font-extrabold flex items-center gap-1.5"
                  >
                    <Send size={13} /> Dispatch Support Response
                  </button>
                </div>

                <div className="space-y-2.5">
                  {notifications.map((n) => (
                    <div
                      key={n.id}
                      className="rounded-2xl bg-white border border-[#E7EDE8] p-3.5 flex items-center justify-between gap-3 text-xs shadow-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded bg-[#E6F6EB] text-[#08743A] font-mono text-[10px] font-bold">
                            {n.event}
                          </span>
                          <b className="text-[#183326]">{n.title}</b>
                          <span className="text-[#68776D]">→ TG #{n.telegramUserId}</span>
                        </div>
                        <p className="text-[#68776D] mt-1 whitespace-pre-line">{n.messageText}</p>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-extrabold shrink-0 ${
                          n.delivered
                            ? 'bg-[#E6F6EB] text-[#168A49]'
                            : 'bg-[#FEF5DC] text-[#9A6B0B]'
                        }`}
                      >
                        {n.delivered ? 'Delivered' : `Skipped (${n.skippedReason})`}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* SECTION 9: ADMIN SETTINGS & IMMUTABLE SHA-256 AUDIT LOG */}
            {activeTab === 'settings' && settingsData && (
              <section data-testid="admin-settings-section" className="space-y-4">
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-5 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                        Security Policies & Immutable SHA-256 Audit Trail
                      </h2>
                      <p className="text-xs text-[#68776D]">
                        Admin roles are strictly controlled by server-side allowlists. Every admin
                        action is cryptographically hash-chained.
                      </p>
                    </div>
                    <div
                      data-testid="admin-audit-integrity-badge"
                      className="px-3 py-1.5 rounded-xl bg-[#E6F6EB] border border-[#159447]/40 text-[#08743A] text-xs font-extrabold flex items-center gap-1.5"
                    >
                      <FileCheck2 size={15} />
                      SHA-256 Chain Valid ({settingsData.auditChainIntegrity.totalEntries} entries)
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8]">
                      <span className="text-[10px] font-bold text-[#68776D] uppercase block">
                        Authorized Admin Telegram IDs
                      </span>
                      <b className="font-mono text-[#183326]">
                        {settingsData.authorizedAdminTelegramIds.join(', ')}
                      </b>
                    </div>
                    <div className="p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8]">
                      <span className="text-[10px] font-bold text-[#68776D] uppercase block">
                        Authorized Owner Emails
                      </span>
                      <b className="font-mono text-[#08743A]">
                        {settingsData.authorizedAdminEmails.join(', ')}
                      </b>
                    </div>
                    <div className="p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8]">
                      <span className="text-[10px] font-bold text-[#68776D] uppercase block">
                        Player Access Isolation
                      </span>
                      <b className="text-[#168A49]">
                        Enforced (HTTP 403 for all non-owner accounts)
                      </b>
                    </div>
                  </div>
                </div>

                {/* Audit Trail List */}
                <div className="rounded-2xl bg-white border border-[#E7EDE8] p-4 space-y-2.5 shadow-xs">
                  <h3 className="font-['Outfit'] text-sm font-extrabold text-[#183326]">
                    Immutable Admin Audit Log
                  </h3>
                  <div className="space-y-2">
                    {settingsData.auditTrail.map((entry) => (
                      <div
                        key={entry.id}
                        data-testid={`admin-audit-entry-${entry.sequence}`}
                        className="p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-0.5 rounded bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] font-mono text-[10px] font-extrabold">
                              #{entry.sequence} · {entry.action}
                            </span>
                            <b className="text-[#183326]">{entry.summary}</b>
                          </div>
                          <span className="text-[11px] text-[#68776D]">
                            By {entry.adminName} · {entry.timestamp}
                          </span>
                        </div>
                        {(entry.previousValue || entry.newValue || entry.notes) && (
                          <div className="text-[11px] text-[#68776D] font-mono">
                            {entry.previousValue ? `Prev: ${entry.previousValue} → ` : ''}
                            {entry.newValue ? `New: ${entry.newValue}` : ''}
                            {entry.notes ? ` · Note: ${entry.notes}` : ''}
                          </div>
                        )}
                        <div className="text-[10px] font-mono text-[#68776D] truncate">
                          SHA-256: {entry.entryHash} (prev: {entry.prevHash.slice(0, 16)}...)
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
