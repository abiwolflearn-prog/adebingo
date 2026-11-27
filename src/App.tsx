import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithCustomToken, User as FirebaseUser } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import {
  Wallet,
  X,
  Trophy,
  Play,
  Clock,
  Users,
  Grid,
} from 'lucide-react';
import {
  DEFAULT_GAME_RULES,
  calculateAuthoritativeGameFinancials,
  checkCardWin,
  generateDeterministicCard,
  toggleCardSelection,
} from './game/rules';
import type { RoundWinnerShare } from './game/roundSettlement';
import { INITIAL_ROOMS } from './data/demoData';
import {
  DepositRequestSummary,
  Language,
  PayoutRequestSummary,
  ReferralRecord,
  RoomConfig,
  ScreenId,
  SupportTicket,
  WalletTransaction,
  WinResult,
} from './types/bingo';
import { soundFX } from './utils/sound';
import {
  getLiveTelegramWebAppUserId,
  getTelegramStartParam,
  initTelegramMiniApp,
  requestTelegramContact,
  syncTelegramBackButton,
  triggerHaptic,
  waitForTelegramWebAppInitData,
} from './utils/telegram';
import { auth, testFirestoreConnection } from './lib/firebase';
import {
  buildAuthenticatedHeaders,
  drawBallViaServerApi,
  ensureDefaultRoomsInFirestore,
  ensureUserProfileInFirestore,
  fetchPlayerStateFromApi,
  fetchRoomDetailFromServerApi,
  fetchRoomsFromServerApi,
  FirestoreRoomPlayer,
  getActiveBearerToken,
  getPrivatePhoneContact,
  resetRoundViaServerApi,
  setSessionBearerToken,
  signOutFromFirebase,
  submitPlayerWalletAction,
  subscribeToGameState,
  subscribeToRoomState,
  subscribeToUserProfile,
  syncLanguagePreference,
  toggleCardReservationAtomic,
  verifyWinnerViaServerApi,
} from './services/firestoreService';
import { WinnerModal } from './components/WinnerModal';
import { BingoCardView } from './components/BingoCardView';
import { LobbyAndCardsScreen } from './components/LobbyAndCardsScreen';
import { LiveGameScreen } from './components/LiveGameScreen';
import { WalletScreens } from './components/WalletScreens';
import { CommunityScreens } from './components/CommunityScreens';
import { AdminDashboardScreen } from './components/AdminDashboardScreen';
import {
  AppHeader,
  BalanceCard,
  BingoBall,
  BingoNumberTile,
  PrimaryButton,
  GameStatusBadge,
  BottomNavigation,
} from './components/DesignSystem';

function checkIsAdminRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams(window.location.search);
  return path === '/admin' || params.get('route') === 'admin';
}

function buildEmptyInitialRooms(): RoomConfig[] {
  return INITIAL_ROOMS.map((rm) => ({
    ...rm,
    activePlayers: 0,
    maxPlayers: 600,
    confirmedPlayersCount: 0,
    verifiedPaidEntriesCount: 0,
    availableSpaces: 600,
    totalCardsSold: 0,
    totalCollectedEtb: 0,
    adeyShareEtb: 0,
    winnersPrizePoolEtb: 0,
    lifecycleStage: 'WAITING',
    takenCardIds: [],
    countdownSeconds: 60,
    status: 'countdown',
  }));
}

const ALL_CARD_NUMBERS = Array.from({ length: DEFAULT_GAME_RULES.maxCardsPerRoom }, (_, i) => i + 1);
const TG_SESSION_STORAGE_KEY = 'adeybingo_verified_session_v2';

interface PersistedTelegramSession {
  sessionToken: string;
  verifiedTelegramId: number;
  authDate: number;
  expiresAtMs: number;
}

interface TelegramClientAuthDiagnostics {
  launchedInTelegram: boolean;
  initDataPresent: boolean;
  telegramHashValid: boolean | null;
  telegramUserIdExtracted: boolean;
  backendAuthSucceeded: boolean;
  firebaseAuthSucceeded: boolean;
  phoneVerificationPending: boolean;
  errorCode: string | null;
}

function extractInitDataAuthDate(rawInitData: string): number {
  try {
    const val = Number(new URLSearchParams(rawInitData).get('auth_date') || 0);
    return Number.isInteger(val) && val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

function loadPersistedTelegramSession(): PersistedTelegramSession | null {
  if (typeof window === 'undefined') return null;
  const stores: Array<Storage | undefined> = [];
  try {
    stores.push(window.sessionStorage);
  } catch {
    // Ignore restricted sessionStorage
  }
  try {
    stores.push(window.localStorage);
  } catch {
    // Ignore restricted localStorage
  }
  const nowMs = Date.now();
  for (const store of stores) {
    if (!store) continue;
    try {
      const raw = store.getItem(TG_SESSION_STORAGE_KEY);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<PersistedTelegramSession>;
      const expiresAtMs =
        typeof parsed.expiresAtMs === 'number' && Number.isFinite(parsed.expiresAtMs)
          ? parsed.expiresAtMs
          : nowMs + 60_000;
      if (
        typeof parsed.sessionToken === 'string' &&
        parsed.sessionToken.trim() &&
        typeof parsed.verifiedTelegramId === 'number' &&
        parsed.verifiedTelegramId > 0 &&
        expiresAtMs > nowMs
      ) {
        return {
          sessionToken: parsed.sessionToken.trim(),
          verifiedTelegramId: parsed.verifiedTelegramId,
          authDate: typeof parsed.authDate === 'number' ? parsed.authDate : 0,
          expiresAtMs,
        };
      }
    } catch {
      // Ignore storage read errors
    }
  }
  return null;
}

function savePersistedTelegramSession(session: PersistedTelegramSession | null): void {
  if (typeof window === 'undefined') return;
  for (const getter of [() => window.sessionStorage, () => window.localStorage]) {
    try {
      const store = getter();
      if (!store) continue;
      if (!session) {
        store.removeItem(TG_SESSION_STORAGE_KEY);
      } else {
        store.setItem(TG_SESSION_STORAGE_KEY, JSON.stringify(session));
      }
    } catch {
      // Ignore storage quota or WebView sandbox errors
    }
  }
}

function formatTelegramAuthErrorMessage(
  errorCode: string,
  lang: Language,
  fallbackServerMessage?: string
): string {
  switch (errorCode) {
    case 'not_in_telegram':
      return lang === 'am'
        ? 'ADEYBINGO ን በቴሌግራም (@AdeyBingoGameBot) ውስጥ ይክፈቱ (ኮድ: not_in_telegram)።'
        : 'Open ADEYBINGO inside Telegram via @AdeyBingoGameBot to authenticate (code: not_in_telegram).';
    case 'missing_init_data':
      return lang === 'am'
        ? 'የቴሌግራም initData አልተገኘም። እባክዎ ከ@AdeyBingoGameBot Menu ወይም Play ቁልፍ እንደገና ይክፈቱ (missing_init_data)።'
        : 'Telegram launch data is missing. Reopen from @AdeyBingoGameBot Menu or Play button (missing_init_data).';
    case 'signature_mismatch':
      return lang === 'am'
        ? 'የቴሌግራም ማረጋገጫ ፊርማ አልተዛመደም (signature_mismatch)። እባክዎ ከ@AdeyBingoGameBot እንደገና ይክፈቱ።'
        : 'Telegram signature verification failed (signature_mismatch). Reopen from @AdeyBingoGameBot.';
    case 'expired_auth_date':
    case 'future_auth_date':
      return lang === 'am'
        ? `የቴሌግራም ክፍለ ጊዜ ጊዜው አልፏል (${errorCode})። Mini App ን ዘግተው ከ@AdeyBingoGameBot እንደገና ይክፈቱ።`
        : `Telegram launch data expired (${errorCode}). Close and reopen the Mini App from @AdeyBingoGameBot.`;
    case 'replay_detected':
      return lang === 'am'
        ? 'ይህ የቴሌግራም መግቢያ ቀደም ብሎ ተጠቅሟል (replay_detected)። አዲስ ክፍለ ጊዜ ለማግኘት ከ@AdeyBingoGameBot እንደገና ይክፈቱ።'
        : 'This Telegram launch session was already used (replay_detected). Reopen from @AdeyBingoGameBot for a fresh session.';
    case 'missing_bot_token':
      return lang === 'am'
        ? 'የሰርቨር ቴሌግራም ቦት ቶከን አልተዋቀረም (missing_bot_token)።'
        : 'Server Telegram bot token is not configured (missing_bot_token).';
    case 'iam_sign_blob_permission_denied':
    case 'invalid_private_key':
    case 'firebase_admin_unconfigured':
    case 'token_mint_failed':
    case 'firebase_admin_unavailable':
      return lang === 'am'
        ? `የFirebase ማረጋገጫ አገልግሎት ችግር (${errorCode})። እባክዎ ከጥቂት ጊዜ በኋላ እንደገና ይሞክሩ።`
        : `Firebase authentication service error (${errorCode}). Please try again shortly.`;
    case 'firebase_auth_failed':
      return lang === 'am'
        ? 'የFirebase ክፍለ ጊዜ ማስገባት አልተሳካም (firebase_auth_failed)።'
        : 'Firebase custom token sign-in failed (firebase_auth_failed).';
    case 'profile_persistence_failed':
      return lang === 'am'
        ? 'የተጫዋች መለያ ማስቀመጥ አልተሳካም (profile_persistence_failed)። እንደገና ይሞክሩ።'
        : 'Failed to save player profile (profile_persistence_failed). Please retry.';
    case 'backend_network_error':
      return lang === 'am'
        ? 'ከሰርቨር ጋር መገናኘት አልተቻለም (backend_network_error)። ኢንተርኔትዎን ያረጋግጡ።'
        : 'Could not reach authentication server (backend_network_error). Check your connection.';
    default:
      return fallbackServerMessage
        ? `${fallbackServerMessage} (${errorCode})`
        : lang === 'am'
          ? `የቴሌግራም ማረጋገጫ አልተሳካም (${errorCode})።`
          : `Telegram authentication error (${errorCode}).`;
  }
}

export default function App() {
  const [user, setUser] = useState(() => initTelegramMiniApp());
  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(() => checkIsAdminRoute());

  useEffect(() => {
    const onPopState = () => setIsAdminRoute(checkIsAdminRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Default language is Amharic ('am'), with English ('en') switching
  const [lang, setLang] = useState<Language>('am');
  const autoAppliedStartRef = useRef<boolean>(false);

  // Support ?autostart=1 to jump directly to the live Bingo game
  const [screen, setScreen] = useState<ScreenId>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') {
        return 'game';
      }
    }
    return 'home';
  });

  // Sync native Telegram WebApp BackButton whenever player navigates away from home
  useEffect(() => {
    return syncTelegramBackButton(screen !== 'home', () => setScreen('home'));
  }, [screen]);

  // Firebase Auth & Firestore connectivity state
  const [fbUser, setFbUser] = useState<FirebaseUser | null>(null);
  const [firestoreConnected, setFirestoreConnected] = useState<boolean>(false);
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [phoneVerified, setPhoneVerified] = useState<boolean>(false);
  const [serverVerifiedTelegramId, setServerVerifiedTelegramId] = useState<number | null>(null);
  const [isVerifiedAdmin, setIsVerifiedAdmin] = useState<boolean>(false);
  const [activeSessionToken, setActiveSessionToken] = useState<string>('');
  const activeSessionTokenRef = useRef<string>('');
  activeSessionTokenRef.current = activeSessionToken;
  const [telegramBackendStatus, setTelegramBackendStatus] = useState<string>(
    'Ready to validate Telegram WebApp initData on /api/telegram/auth'
  );
  const [authDiagnostics, setAuthDiagnostics] = useState<TelegramClientAuthDiagnostics>({
    launchedInTelegram: false,
    initDataPresent: false,
    telegramHashValid: null,
    telegramUserIdExtracted: false,
    backendAuthSucceeded: false,
    firebaseAuthSucceeded: false,
    phoneVerificationPending: false,
    errorCode: null,
  });
  const [onboardingContactBusy, setOnboardingContactBusy] = useState<boolean>(false);

  const recordAuthDiagnostics = useCallback(
    (patch: Partial<TelegramClientAuthDiagnostics>) => {
      setAuthDiagnostics((prev) => {
        const next: TelegramClientAuthDiagnostics = { ...prev, ...patch };
        console.info('[adeybingo/telegram-auth]', next);
        return next;
      });
    },
    []
  );

  // Rooms & Lobby state (hydrated from backend — zero fabricated players/countdown)
  const [rooms, setRooms] = useState<RoomConfig[]>(() => buildEmptyInitialRooms());
  const [activeRoomId, setActiveRoomId] = useState<string>(INITIAL_ROOMS[0].id);
  const [roomPlayers, setRoomPlayers] = useState<FirestoreRoomPlayer[]>([]);
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? rooms[0];

  const isCardsLocked = activeRoom.status === 'live' || activeRoom.status === 'completed';

  // Configurable card price from active room
  const [cardPrice, setCardPrice] = useState<number>(DEFAULT_GAME_RULES.defaultCardPrice);
  const [countdown, setCountdown] = useState<number>(0);
  const serverClockOffsetMsRef = useRef<number>(0);
  const roomDeadlineMsRef = useRef<number>(0);
  const nextBallDrawAtMsRef = useRef<number>(0);
  const activeRoomIdRef = useRef<string>(activeRoomId);
  activeRoomIdRef.current = activeRoomId;
  const hydratedRoomIdRef = useRef<string>('');
  const hasServerRoomSyncRef = useRef<boolean>(false);
  const prevRoomStatusRef = useRef<RoomConfig['status']>('countdown');
  const lastRoundNumberRef = useRef<number>(0);
  const lastExtendedCountRef = useRef<Record<string, number>>({});
  const localWinnerSettledRoundRef = useRef<boolean>(false);
  const roomHydrateInFlightRef = useRef<boolean>(false);
  const langRef = useRef<Language>(lang);
  langRef.current = lang;

  // Player selected card IDs (1..600, max 4 cards per player)
  const [selectedCardIds, setSelectedCardIds] = useState<number[]>([]);

  // Live Game state (starts clean with zero fabricated calls)
  const [calls, setCalls] = useState<number[]>([]);
  const [marked, setMarked] = useState<number[]>([]);
  const [autoMark, setAutoMark] = useState<boolean>(true);
  const [autoCallerActive, setAutoCallerActive] = useState<boolean>(false);
  const [callerIntervalSec, setCallerIntervalSec] = useState<number>(3);
  const [winnerModalOpen, setWinnerModalOpen] = useState<boolean>(false);
  const [activeWinResult, setActiveWinResult] = useState<WinResult | null>(null);
  const [lastVerifiedPrizeEtb, setLastVerifiedPrizeEtb] = useState<number>(0);
  const [roundWinners, setRoundWinners] = useState<RoundWinnerShare[]>([]);
  const [winningCardOverride, setWinningCardOverride] = useState<number | null>(null);
  const screenRef = useRef<ScreenId>(screen);
  screenRef.current = screen;
  const selectedCardIdsRef = useRef<number[]>(selectedCardIds);
  selectedCardIdsRef.current = selectedCardIds;
  const activeUidRef = useRef<string>(fbUser?.uid || '');
  activeUidRef.current =
    fbUser?.uid || (serverVerifiedTelegramId ? `tg_${serverVerifiedTelegramId}` : '');
  const activeTgIdRef = useRef<number>(serverVerifiedTelegramId ?? 0);
  activeTgIdRef.current = serverVerifiedTelegramId ?? 0;

  // Account & financial state — hydrated strictly from persistent backend / Firestore (never fabricated locally)
  const [demoBalance, setDemoBalance] = useState<number>(0);
  const [winningsBalance, setWinningsBalance] = useState<number>(0);
  const [referralCode, setReferralCode] = useState<string>('');
  const [referredByCode, setReferredByCode] = useState<string>('');
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [depositRequests, setDepositRequests] = useState<DepositRequestSummary[]>([]);
  const [payoutRequests, setPayoutRequests] = useState<PayoutRequestSummary[]>([]);
  const [referrals, setReferrals] = useState<ReferralRecord[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);

  // Audio, Voice, Motion & Toast state
  const [sound, setSound] = useState<boolean>(true);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  const [toast, setToast] = useState<string>('');
  const lastSpokenBallRef = useRef<number | null>(null);

  const playerCards = selectedCardIds.map((id) => generateDeterministicCard(id));

  const syncUserIdentityFromServer = useCallback(
    (incoming: {
      telegramUserId?: number;
      displayName?: string;
      firstName?: string;
      lastName?: string;
      username?: string;
      language?: Language;
      referralCode?: string;
    }) => {
      const nextId =
        typeof incoming.telegramUserId === 'number' &&
        Number.isInteger(incoming.telegramUserId) &&
        incoming.telegramUserId > 0
          ? incoming.telegramUserId
          : null;
      const incomingRef = (incoming.referralCode || '').trim().toUpperCase();
      if (incomingRef) {
        setReferralCode(incomingRef);
      } else if (nextId) {
        setReferralCode(`ADEY-${nextId}`);
      }
      const rawDisplay = (incoming.displayName || '').trim();
      const parts = rawDisplay ? rawDisplay.split(/\s+/) : [];
      const first = (incoming.firstName || parts[0] || '').trim();
      const last = (incoming.lastName ?? (parts.length > 1 ? parts.slice(1).join(' ') : '')).trim();
      const rawUsername = (incoming.username || '').trim();
      const normalizedUsername = rawUsername
        ? rawUsername.startsWith('@')
          ? rawUsername
          : `@${rawUsername}`
        : '';

      if (!nextId && !first && !normalizedUsername) return;
      setUser((prev) => {
        const resolvedFirst = first || prev.firstName;
        const resolvedLast = first ? last : prev.lastName || '';
        const initials = `${resolvedFirst[0] || 'A'}${resolvedLast[0] || resolvedFirst[1] || 'B'}`.toUpperCase();
        return {
          ...prev,
          id: nextId ?? prev.id,
          firstName: resolvedFirst,
          lastName: resolvedLast,
          username: normalizedUsername || prev.username,
          languageCode: incoming.language || prev.languageCode,
          initials,
        };
      });
    },
    []
  );

  const hydratePlayerState = useCallback(async () => {
    try {
      const state = await fetchPlayerStateFromApi();
      if (!state || !state.ok) return false;
      if (typeof state.serverNowMs === 'number' && Number.isFinite(state.serverNowMs)) {
        serverClockOffsetMsRef.current = state.serverNowMs - Date.now();
      }
      setDemoBalance(Number(state.wallet.availableBalanceEtb ?? 0));
      setWinningsBalance(Number(state.wallet.winningsBalanceEtb ?? 0));
      setTransactions(Array.isArray(state.transactions) ? state.transactions : []);
      setDepositRequests(Array.isArray(state.depositRequests) ? state.depositRequests : []);
      setPayoutRequests(Array.isArray(state.payoutRequests) ? state.payoutRequests : []);
      setReferrals(Array.isArray(state.referrals) ? state.referrals : []);
      if (Array.isArray(state.supportTickets)) {
        setTickets(state.supportTickets);
      }
      if (state.profile) {
        syncUserIdentityFromServer({
          telegramUserId: state.profile.telegramUserId,
          displayName: state.profile.displayName,
          username: state.profile.username,
          language: state.profile.language,
          referralCode: state.profile.referralCode,
        });
        if (
          typeof state.profile.telegramUserId === 'number' &&
          Number.isInteger(state.profile.telegramUserId) &&
          state.profile.telegramUserId > 0
        ) {
          setServerVerifiedTelegramId(state.profile.telegramUserId);
        }
        if (state.profile.referralCode) {
          setReferralCode(state.profile.referralCode);
        }
        setReferredByCode(state.profile.referredByCode || '');
        if (typeof state.profile.phoneVerified === 'boolean') {
          setPhoneVerified(state.profile.phoneVerified);
        }
        if (state.profile.language === 'am' || state.profile.language === 'en') {
          setLang(state.profile.language);
        }
      }
      return true;
    } catch {
      return false;
    }
  }, [syncUserIdentityFromServer]);

  const hydrateRoomState = useCallback(async (roomIdToLoad: string) => {
    if (roomHydrateInFlightRef.current) return;
    roomHydrateInFlightRef.current = true;
    try {
      const token = await getActiveBearerToken();
      // Fetch active room detail first so a single client never fires two concurrent
      // Firestore scheduler transactions on the same room at the exact same millisecond.
      const detail = await fetchRoomDetailFromServerApi(roomIdToLoad).catch(() => null);
      const serverRooms = await fetchRoomsFromServerApi((serverNowMs) => {
        serverClockOffsetMsRef.current = serverNowMs - Date.now();
      }).catch(() => []);

      if (serverRooms.length > 0) {
        hasServerRoomSyncRef.current = true;
        setRooms((prev) =>
          prev.map((rm) => {
            const match = serverRooms.find((sr) => sr.roomId === rm.id);
            if (!match) return rm;
            const nextRmStatus =
              localWinnerSettledRoundRef.current && rm.id === roomIdToLoad && match.status === 'live'
                ? 'completed'
                : match.status || 'countdown';
            const confirmedPlayers = Number(
              match.confirmedPlayersCount ?? match.activePlayersCount ?? 0
            );
            const totalCards = Number(match.totalCardsSold ?? match.reservedCardsCount ?? 0);
            const financials = calculateAuthoritativeGameFinancials(
              confirmedPlayers,
              totalCards,
              Number(match.cardPrice || rm.cardPrice || 10)
            );
            return {
              ...rm,
              cardPrice: Number(match.cardPrice || rm.cardPrice),
              activePlayers: financials.confirmedPlayersCount,
              maxPlayers: Number(match.maxPlayersPerRoom ?? 600),
              confirmedPlayersCount: financials.confirmedPlayersCount,
              verifiedPaidEntriesCount: Number(
                match.verifiedPaidEntriesCount ?? financials.verifiedPaidEntriesCount
              ),
              availableSpaces: Number(match.availableSpaces ?? financials.availableSpaces),
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: Number(match.totalCollectedEtb ?? financials.totalCollectedEtb),
              adeyShareEtb: Number(match.adeyShareEtb ?? financials.adeyShareEtb),
              winnersPrizePoolEtb: Number(
                match.winnersPrizePoolEtb ?? financials.winnersPrizePoolEtb
              ),
              lifecycleStage: match.lifecycleStage || rm.lifecycleStage || 'WAITING',
              countdownSeconds: Number(match.countdownSeconds ?? 0),
              status: nextRmStatus,
            };
          })
        );

        if (!detail && activeRoomIdRef.current === roomIdToLoad) {
          const matchedActive = serverRooms.find((sr) => sr.roomId === roomIdToLoad);
          if (matchedActive) {
            const matchedStatus = matchedActive.status || 'countdown';
            const fallbackDeadline =
              typeof matchedActive.registrationDeadlineMs === 'number' &&
              Number.isFinite(matchedActive.registrationDeadlineMs) &&
              matchedActive.registrationDeadlineMs > 0
                ? matchedActive.registrationDeadlineMs
                : 0;
            const fallbackIntermission =
              typeof matchedActive.intermissionEndsAtMs === 'number' &&
              Number.isFinite(matchedActive.intermissionEndsAtMs) &&
              matchedActive.intermissionEndsAtMs > 0
                ? matchedActive.intermissionEndsAtMs
                : 0;
            if ((matchedStatus === 'countdown' || matchedStatus === 'waiting') && fallbackDeadline > 0) {
              roomDeadlineMsRef.current = fallbackDeadline;
              setCountdown(
                Math.max(
                  0,
                  Math.ceil((fallbackDeadline - (Date.now() + serverClockOffsetMsRef.current)) / 1000)
                )
              );
            } else if (matchedStatus === 'completed' && fallbackIntermission > 0) {
              roomDeadlineMsRef.current = fallbackIntermission;
              setCountdown(
                Math.max(
                  0,
                  Math.ceil(
                    (fallbackIntermission - (Date.now() + serverClockOffsetMsRef.current)) / 1000
                  )
                )
              );
            }
          }
        }
      }

      if (detail) {
        // Ignore stale async response if the player switched to another room while this fetch was in flight
        if (activeRoomIdRef.current !== roomIdToLoad) {
          return;
        }
        hasServerRoomSyncRef.current = true;
        const isSameHydratedRoom = hydratedRoomIdRef.current === roomIdToLoad;
        const rawNextStatus: RoomConfig['status'] = detail.room.status || 'countdown';
        const prevStatus = isSameHydratedRoom ? prevRoomStatusRef.current : rawNextStatus;

        const serverRoundNumber = Number(detail.room.roundNumber ?? detail.game?.roundNumber ?? 0);
        const isNewRoundNumber =
          isSameHydratedRoom &&
          serverRoundNumber > 0 &&
          lastRoundNumberRef.current > 0 &&
          serverRoundNumber > lastRoundNumberRef.current;
        if (isNewRoundNumber) {
          localWinnerSettledRoundRef.current = false;
        }
        if (serverRoundNumber > 0) {
          lastRoundNumberRef.current = serverRoundNumber;
        }

        // If local round already announced a winner while server was mid-round, wait until server restarts countdown
        if (localWinnerSettledRoundRef.current && rawNextStatus === 'live') {
          return;
        }
        const nextStatus = rawNextStatus;

        // Countdown finished -> switch into live game ONLY if player has selected at least 1 card
        if (
          isSameHydratedRoom &&
          (prevStatus === 'countdown' || prevStatus === 'waiting') &&
          nextStatus === 'live'
        ) {
          const hasCards =
            (token ? detail.myCardIds.length : selectedCardIdsRef.current.length) > 0;
          if (hasCards) {
            if (
              screenRef.current === 'home' ||
              screenRef.current === 'lobby' ||
              screenRef.current === 'cards'
            ) {
              setScreen('game');
            }
            setToast(
              langRef.current === 'am'
                ? '60 ሰከንዱ አልቋል — ጨዋታው በተመረጡ ካርዶችዎ ተጀምሯል!'
                : 'Timer finished — game started with your selected cards!'
            );
          } else {
            if (screenRef.current === 'game') {
              setScreen('home');
            }
            setToast(
              langRef.current === 'am'
                ? '60 ሰከንዱ አልቋል — ካርድ ስላልመረጡ በዚህ ዙር መጫወት አይችሉም!'
                : 'Timer ended — you cannot play this round without a selected card!'
            );
          }
        }

        // Round completed -> immediately terminate auto-calling & voice; show winner modal if winners exist
        if (nextStatus === 'completed') {
          setAutoCallerActive(false);
          soundFX.stopVoice();
        }
        const serverCalls =
          detail.game && Array.isArray(detail.game.calledNumbers)
            ? detail.game.calledNumbers
            : [];
        if (
          prevStatus !== 'completed' &&
          nextStatus === 'completed' &&
          detail.game?.winners &&
          detail.game.winners.length > 0
        ) {
          const winnersList = detail.game.winners;
          const myWins = winnersList.filter(
            (w) =>
              w.uid === activeUidRef.current ||
              (activeTgIdRef.current > 0 && w.telegramUserId === activeTgIdRef.current)
          );
          const primary = myWins[0] || winnersList[0];
          const myTotal = myWins.reduce((s, w) => s + w.prizeEtb, 0);
          const cardObj = generateDeterministicCard(primary.cardId);
          const winCheck = checkCardWin(cardObj, serverCalls, serverCalls, true);

          setAutoCallerActive(false);
          soundFX.stopVoice();
          setRoundWinners(winnersList);
          setWinningCardOverride(primary.cardId);
          setActiveWinResult(
            winCheck.won
              ? winCheck
              : {
                  won: true,
                  cardId: primary.cardId,
                  patternType: primary.patternType,
                  patternLabelAm: primary.patternLabelAm,
                  patternLabelEn: primary.patternLabelEn,
                  winningCells: primary.winningCells,
                }
          );
          setLastVerifiedPrizeEtb(myWins.length > 0 ? myTotal : primary.prizeEtb);
          setWinnerModalOpen(true);
          soundFX.playWinFanfare(true);
          void hydratePlayerState();
        }

        // New round started -> reset board, unlock 60s card selection, and return from live board for continuous play
        if (
          isSameHydratedRoom &&
          (isNewRoundNumber ||
            ((prevStatus === 'live' || prevStatus === 'completed' || localWinnerSettledRoundRef.current) &&
              (nextStatus === 'countdown' || nextStatus === 'waiting')))
        ) {
          localWinnerSettledRoundRef.current = false;
          setMarked([]);
          setCalls([]);
          setWinnerModalOpen(false);
          setActiveWinResult(null);
          setLastVerifiedPrizeEtb(0);
          setRoundWinners([]);
          setWinningCardOverride(null);
          setAutoCallerActive(false);
          soundFX.stopVoice();
          setSelectedCardIds([]);
          if (screenRef.current === 'game' && (nextStatus === 'countdown' || nextStatus === 'waiting')) {
            setScreen('cards');
          }
          setToast(
            langRef.current === 'am'
              ? 'አዲስ የ60 ሰከንድ ዙር ተጀምሯል — ካርድ ይምረጡ!'
              : 'New 60s round started — pick your cards!'
          );
        }
        hydratedRoomIdRef.current = roomIdToLoad;
        prevRoomStatusRef.current = nextStatus;

        const extendedCount = Number(detail.room.extendedRegistrationCount ?? 0);
        const prevExtendedCount = lastExtendedCountRef.current[roomIdToLoad] ?? 0;
        if (
          (nextStatus === 'countdown' || nextStatus === 'waiting') &&
          extendedCount > prevExtendedCount &&
          prevExtendedCount >= 0 &&
          hasServerRoomSyncRef.current
        ) {
          const noticeText =
            langRef.current === 'am'
              ? detail.room.scheduleNoticeAm ||
                'ዝቅተኛው የተጫዋች ቁጥር (3) ስላልሞላ ምዝገባ ተራዝሟል። ካርድዎ ተጠብቋል።'
              : detail.room.scheduleNoticeEn ||
                'Minimum 3 paid players not yet reached — registration extended; your cards are preserved.';
          setToast(noticeText);
        }
        lastExtendedCountRef.current[roomIdToLoad] = extendedCount;

        if (typeof detail.serverNowMs === 'number' && Number.isFinite(detail.serverNowMs)) {
          serverClockOffsetMsRef.current = detail.serverNowMs - Date.now();
        }
        const deadlineMs =
          typeof detail.room.registrationDeadlineMs === 'number' &&
          Number.isFinite(detail.room.registrationDeadlineMs) &&
          detail.room.registrationDeadlineMs > 0
            ? detail.room.registrationDeadlineMs
            : 0;
        const intermissionDeadlineMs =
          typeof detail.room.intermissionEndsAtMs === 'number' &&
          Number.isFinite(detail.room.intermissionEndsAtMs) &&
          detail.room.intermissionEndsAtMs > 0
            ? detail.room.intermissionEndsAtMs
            : 0;
        const liveNextDrawMs =
          typeof detail.room.nextBallDrawAtMs === 'number' &&
          Number.isFinite(detail.room.nextBallDrawAtMs) &&
          detail.room.nextBallDrawAtMs > 0
            ? detail.room.nextBallDrawAtMs
            : 0;
        if ((nextStatus === 'countdown' || nextStatus === 'waiting') && deadlineMs > 0) {
          roomDeadlineMsRef.current = deadlineMs;
          nextBallDrawAtMsRef.current = 0;
          const syncedRemaining = Math.max(
            0,
            Math.ceil((deadlineMs - (Date.now() + serverClockOffsetMsRef.current)) / 1000)
          );
          setCountdown(syncedRemaining);
        } else if (nextStatus === 'completed' && intermissionDeadlineMs > 0) {
          roomDeadlineMsRef.current = intermissionDeadlineMs;
          nextBallDrawAtMsRef.current = 0;
          const syncedIntermission = Math.max(
            0,
            Math.ceil(
              (intermissionDeadlineMs - (Date.now() + serverClockOffsetMsRef.current)) / 1000
            )
          );
          setCountdown(syncedIntermission);
        } else if (nextStatus === 'live') {
          roomDeadlineMsRef.current = 0;
          nextBallDrawAtMsRef.current = liveNextDrawMs;
          setCountdown(0);
        } else {
          roomDeadlineMsRef.current = 0;
          nextBallDrawAtMsRef.current = 0;
          setCountdown(Number(detail.room.countdownSeconds ?? 0));
        }
        setCardPrice(Number(detail.room.cardPrice || DEFAULT_GAME_RULES.defaultCardPrice));
        const mySortedCards = [...detail.myCardIds].sort((a, b) => a - b);
        const myCardSet = new Set(mySortedCards);
        const otherTakenCards = detail.takenCardIds.filter((id) => !myCardSet.has(id));
        if (token) {
          setSelectedCardIds(mySortedCards);
        }
        const confirmedPlayers = Number(
          detail.room.confirmedPlayersCount ?? detail.room.activePlayersCount ?? 0
        );
        const totalCards = Number(
          detail.room.totalCardsSold ?? detail.takenCardIds.length ?? 0
        );
        const financials = calculateAuthoritativeGameFinancials(
          confirmedPlayers,
          totalCards,
          Number(detail.room.cardPrice || DEFAULT_GAME_RULES.defaultCardPrice)
        );
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === roomIdToLoad
              ? {
                  ...rm,
                  activePlayers: financials.confirmedPlayersCount,
                  maxPlayers: Number(detail.room.maxPlayersPerRoom ?? 600),
                  confirmedPlayersCount: financials.confirmedPlayersCount,
                  verifiedPaidEntriesCount: Number(
                    detail.room.verifiedPaidEntriesCount ?? financials.verifiedPaidEntriesCount
                  ),
                  availableSpaces: Number(
                    detail.room.availableSpaces ?? financials.availableSpaces
                  ),
                  totalCardsSold: financials.totalCardsSold,
                  totalCollectedEtb: Number(
                    detail.room.totalCollectedEtb ?? financials.totalCollectedEtb
                  ),
                  adeyShareEtb: Number(detail.room.adeyShareEtb ?? financials.adeyShareEtb),
                  winnersPrizePoolEtb: Number(
                    detail.room.winnersPrizePoolEtb ?? financials.winnersPrizePoolEtb
                  ),
                  lifecycleStage: detail.room.lifecycleStage || rm.lifecycleStage || 'WAITING',
                  takenCardIds: otherTakenCards,
                  countdownSeconds: Number(detail.room.countdownSeconds ?? 0),
                  status: nextStatus,
                }
              : rm
          )
        );
        setCalls(serverCalls);
      }
    } catch {
      // Ignore transient API polling failures
    } finally {
      roomHydrateInFlightRef.current = false;
    }
  }, [hydratePlayerState]);

  // 1. Verify Firestore connection & listen to Firebase Auth + Telegram Mini App initData
  useEffect(() => {
    testFirestoreConnection().then((ok) => setFirestoreConnected(ok));
    ensureDefaultRoomsInFirestore().catch(() => {});

    const unsubAuth = onAuthStateChanged(auth, async (currentUser) => {
      setFbUser(currentUser);
      if (currentUser) {
        try {
          const tokenRes = await currentUser.getIdTokenResult().catch(() => null);
          const claimTgId = Number(
            tokenRes?.claims?.telegram_id ?? tokenRes?.claims?.telegramUserId
          );
          let resolvedTgId: number | null = null;
          if (Number.isInteger(claimTgId) && claimTgId > 0) {
            resolvedTgId = claimTgId;
            setServerVerifiedTelegramId(claimTgId);
          } else {
            const uidMatch = /^tg_([1-9]\d*)$/.exec(currentUser.uid);
            if (uidMatch) {
              resolvedTgId = Number(uidMatch[1]);
              setServerVerifiedTelegramId(resolvedTgId);
            }
          }

          const profile = await ensureUserProfileInFirestore(currentUser, user, lang).catch(
            () => null
          );
          if (profile) {
            setPhoneVerified(profile.phoneVerified);
            if (profile.language === 'am' || profile.language === 'en') {
              setLang(profile.language);
            }
            if (typeof profile.demoBalanceEtb === 'number') {
              setDemoBalance(profile.demoBalanceEtb);
            }
          }
          const privContact = await getPrivatePhoneContact(currentUser.uid).catch(() => null);
          if (privContact) {
            setPhoneNumber(privContact.phoneNumber);
            setPhoneVerified(privContact.phoneVerified);
          }
          recordAuthDiagnostics({
            telegramUserIdExtracted: Boolean(resolvedTgId),
            firebaseAuthSucceeded: true,
            phoneVerificationPending: !(privContact?.phoneVerified ?? profile?.phoneVerified ?? false),
          });
          // Server-side verification for admin visibility (ordinary players always remain false)
          const idToken = await currentUser.getIdToken().catch(() => '');
          if (idToken) {
            fetch('/api/admin/session', {
              method: 'GET',
              headers: { Authorization: `Bearer ${idToken}` },
            })
              .then((resp) => (resp.ok ? resp.json() : null))
              .then((data) => {
                if (data?.authorized === true) {
                  setIsVerifiedAdmin(true);
                }
              })
              .catch(() => {});
          }
          void hydratePlayerState();
          void hydrateRoomState(activeRoomId);
        } catch (err) {
          console.error('Error syncing authenticated user profile:', err);
        }
      } else if (!activeSessionTokenRef.current) {
        // Only clear verified Telegram ID when there is no active verified server session token
        setServerVerifiedTelegramId(null);
        setIsVerifiedAdmin(false);
      }
    });

    // Attempt automatic Telegram Mini App initData authentication when launched inside Telegram
    let cancelled = false;
    void (async () => {
      const launchCtx = await waitForTelegramWebAppInitData(1500);
      if (cancelled) return;

      const rawInitData = launchCtx.initData;
      const incomingAuthDate = rawInitData ? extractInitDataAuthDate(rawInitData) : 0;

      // 1) Reuse existing verified session across Mini App reloads / WebView resumes to avoid initData replay 409
      const savedSession = loadPersistedTelegramSession();
      const liveTgUserId = getLiveTelegramWebAppUserId();
      const sessionMatchesLiveUser =
        !liveTgUserId || !savedSession || savedSession.verifiedTelegramId === liveTgUserId;
      const isNewerTelegramLaunch =
        Boolean(savedSession && incomingAuthDate > 0 && savedSession.authDate > 0 && incomingAuthDate > savedSession.authDate);
      if (savedSession && !sessionMatchesLiveUser) {
        setSessionBearerToken('');
        setActiveSessionToken('');
        savePersistedTelegramSession(null);
      }
      if (savedSession && sessionMatchesLiveUser && !isNewerTelegramLaunch) {
        setSessionBearerToken(savedSession.sessionToken);
        setActiveSessionToken(savedSession.sessionToken);
        const restored = await hydratePlayerState();
        if (cancelled) return;
        if (restored) {
          setServerVerifiedTelegramId(savedSession.verifiedTelegramId);
          setTelegramBackendStatus(
            `✓ Authenticated on Server: TG User #${savedSession.verifiedTelegramId}`
          );
          recordAuthDiagnostics({
            launchedInTelegram: launchCtx.launchedInTelegram,
            initDataPresent: rawInitData.length > 0,
            telegramHashValid: true,
            telegramUserIdExtracted: true,
            backendAuthSucceeded: true,
            firebaseAuthSucceeded: Boolean(auth.currentUser),
            errorCode: null,
          });
          fetch('/api/admin/session', {
            method: 'GET',
            headers: { Authorization: `Bearer ${savedSession.sessionToken}` },
          })
            .then((resp) => (resp.ok ? resp.json() : null))
            .then((data) => {
              if (!cancelled) {
                setIsVerifiedAdmin(Boolean(data?.authorized === true));
              }
            })
            .catch(() => {
              if (!cancelled) setIsVerifiedAdmin(false);
            });
          await hydrateRoomState(activeRoomId);
          return;
        }
        // Stored session expired or invalid -> clear and re-authenticate
        setSessionBearerToken('');
        setActiveSessionToken('');
        savePersistedTelegramSession(null);
      }

      if (!rawInitData) {
        const missingCode = launchCtx.launchedInTelegram ? 'missing_init_data' : 'not_in_telegram';
        recordAuthDiagnostics({
          launchedInTelegram: launchCtx.launchedInTelegram,
          initDataPresent: false,
          telegramHashValid: false,
          telegramUserIdExtracted: false,
          backendAuthSucceeded: false,
          firebaseAuthSucceeded: Boolean(auth.currentUser),
          phoneVerificationPending: false,
          errorCode: missingCode,
        });
        setTelegramBackendStatus(
          launchCtx.launchedInTelegram
            ? `Missing Telegram initData (${missingCode}) — reopen via @AdeyBingoGameBot Menu or Play button.`
            : `Opened outside Telegram (${missingCode}) — open inside @AdeyBingoGameBot Mini App to authenticate.`
        );
        return;
      }

      try {
        const freshStartParam = getTelegramStartParam() || user.startParam;
        const r = await fetch('/api/telegram/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            initData: rawInitData,
            ...(freshStartParam ? { startParam: freshStartParam } : {}),
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (r.ok && d.ok) {
          const verifiedId = Number(
            d.verifiedTelegramId ?? d.profile?.telegramUserId ?? d.telegramUser?.id
          );
          if (Number.isInteger(verifiedId) && verifiedId > 0) {
            setServerVerifiedTelegramId(verifiedId);
          }
          syncUserIdentityFromServer({
            telegramUserId: Number.isInteger(verifiedId) && verifiedId > 0 ? verifiedId : undefined,
            displayName: d.displayName,
            firstName: d.profile?.firstName ?? d.telegramUser?.first_name,
            lastName: d.profile?.lastName ?? d.telegramUser?.last_name,
            username: d.profile?.username ?? d.telegramUser?.username,
            language: d.profile?.language === 'en' ? 'en' : d.profile?.language === 'am' ? 'am' : undefined,
            referralCode: d.profile?.referralCode,
          });
          const verifiedAdminFlag = Boolean(d.isAdmin === true || d.role === 'admin');
          setIsVerifiedAdmin(verifiedAdminFlag);
          if (d.sessionToken) {
            setSessionBearerToken(d.sessionToken);
            setActiveSessionToken(d.sessionToken);
            if (Number.isInteger(verifiedId) && verifiedId > 0) {
              savePersistedTelegramSession({
                sessionToken: d.sessionToken,
                verifiedTelegramId: verifiedId,
                authDate: incomingAuthDate,
                expiresAtMs: Date.now() + 55 * 60 * 1000,
              });
            }
          }
          const profileBalance = d.profile?.demoBalanceEtb ?? d.demoBalanceEtb;
          if (typeof profileBalance === 'number') setDemoBalance(profileBalance);
          const profilePhoneVerified = Boolean(d.profile?.phoneVerified ?? d.phoneVerified ?? false);
          setPhoneVerified(profilePhoneVerified);
          const profileLang = d.profile?.language;
          if (profileLang === 'am' || profileLang === 'en') {
            setLang(profileLang);
          }
          if (d.referralApplied?.applied) {
            autoAppliedStartRef.current = true;
            setToast(
              langRef.current === 'am'
                ? 'በጓደኛ ግብዣ ተቀላቅለዋል! የ15.00 ብር መነሻ ሂሳብዎ ዝግጁ ነው።'
                : 'Joined via friend invite! Your 15.00 ETB initial balance is ready.'
            );
          }
          let fbAuthOk = Boolean(auth.currentUser);
          let fbAuthNote = '';
          if (d.customToken) {
            try {
              await signInWithCustomToken(auth, d.customToken);
              fbAuthOk = true;
            } catch (fbErr) {
              fbAuthOk = false;
              const errCode =
                fbErr && typeof fbErr === 'object' && 'code' in fbErr
                  ? String((fbErr as { code?: unknown }).code || 'firebase_auth_failed')
                  : 'firebase_auth_failed';
              console.warn('[adeybingo/telegram-auth] Firebase custom token sign-in fallback:', errCode);
              fbAuthNote = ` (Session fallback: ${errCode})`;
            }
          }
          const phonePending = !profilePhoneVerified && !verifiedAdminFlag;
          recordAuthDiagnostics({
            launchedInTelegram: true,
            initDataPresent: true,
            telegramHashValid: true,
            telegramUserIdExtracted: Number.isInteger(verifiedId) && verifiedId > 0,
            backendAuthSucceeded: true,
            firebaseAuthSucceeded: fbAuthOk,
            phoneVerificationPending: phonePending,
            errorCode: phonePending ? 'phone_verification_required' : null,
          });
          setTelegramBackendStatus(
            `✓ Authenticated on Server: TG User #${verifiedId || d.telegramUser?.id || ''}${fbAuthNote}`
          );
          await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoomId)]);
        } else {
          const errCode = String(d.reason || d.error || (r.status >= 500 ? 'backend_http_error' : 'auth_rejected'));
          // If replay_detected occurred while Firebase Auth is already signed in for this Telegram user, recover cleanly
          if (errCode === 'replay_detected' && auth.currentUser && liveTgUserId) {
            const recovered = await hydratePlayerState();
            if (recovered && !cancelled) {
              setServerVerifiedTelegramId(liveTgUserId);
              recordAuthDiagnostics({
                launchedInTelegram: true,
                initDataPresent: true,
                telegramHashValid: true,
                telegramUserIdExtracted: true,
                backendAuthSucceeded: true,
                firebaseAuthSucceeded: true,
                errorCode: null,
              });
              setTelegramBackendStatus(
                `✓ Authenticated on Server: TG User #${liveTgUserId} (active session)`
              );
              await hydrateRoomState(activeRoomId);
              return;
            }
          }
          const serverDiag = d.authDiagnostics as Partial<TelegramClientAuthDiagnostics> | undefined;
          recordAuthDiagnostics({
            launchedInTelegram: launchCtx.launchedInTelegram,
            initDataPresent: true,
            telegramHashValid: serverDiag?.telegramHashValid ?? (errCode === 'replay_detected'),
            telegramUserIdExtracted: serverDiag?.telegramUserIdExtracted ?? false,
            backendAuthSucceeded: false,
            firebaseAuthSucceeded: false,
            phoneVerificationPending: serverDiag?.phoneVerificationPending ?? false,
            errorCode: errCode,
          });
          const category = d.diagnostics?.failureCategory
            ? ` [${d.diagnostics.failureCategory}]`
            : '';
          const errSummary = `Auth failed (${r.status}): ${errCode}${category} — ${d.message || 'Verification failed'}`;
          setTelegramBackendStatus(errSummary);
          setToast(formatTelegramAuthErrorMessage(errCode, langRef.current, d.message));
        }
      } catch (err) {
        if (!cancelled) {
          recordAuthDiagnostics({
            launchedInTelegram: launchCtx.launchedInTelegram,
            initDataPresent: true,
            telegramHashValid: null,
            telegramUserIdExtracted: false,
            backendAuthSucceeded: false,
            firebaseAuthSucceeded: false,
            phoneVerificationPending: false,
            errorCode: 'backend_network_error',
          });
          setTelegramBackendStatus(
            `Auth network error (backend_network_error): ${err instanceof Error ? err.message : 'Network failure'}`
          );
          setToast(formatTelegramAuthErrorMessage('backend_network_error', langRef.current));
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubAuth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Real-time Firestore listeners & backend room polling for active room
  useEffect(() => {
    void hydrateRoomState(activeRoomId);
    const poll = window.setInterval(() => {
      void hydrateRoomState(activeRoomId);
    }, 2000);

    if (!fbUser) {
      return () => window.clearInterval(poll);
    }

    const unsubRoom = subscribeToRoomState(
      activeRoomId,
      (reservations) => {
        const myCards: number[] = [];
        const otherTakenCards: number[] = [];
        for (const r of reservations) {
          if (r.ownerId === fbUser.uid) {
            myCards.push(r.cardId);
          } else {
            otherTakenCards.push(r.cardId);
          }
        }
        setSelectedCardIds(myCards.sort((a, b) => a - b));
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? {
                  ...rm,
                  takenCardIds: otherTakenCards,
                }
              : rm
          )
        );
      },
      (players) => {
        setRoomPlayers(players);
        const confirmedCount = players.filter(
          (p) => Array.isArray(p.cardIds) && p.cardIds.length > 0
        ).length;
        const totalSold = players.reduce(
          (sum, p) => sum + (Array.isArray(p.cardIds) ? p.cardIds.length : 0),
          0
        );
        setRooms((prev) =>
          prev.map((rm) => {
            if (rm.id !== activeRoomId) return rm;
            const roomPrice = Number(rm.cardPrice || DEFAULT_GAME_RULES.defaultCardPrice);
            const financials = calculateAuthoritativeGameFinancials(
              confirmedCount,
              totalSold,
              roomPrice
            );
            return {
              ...rm,
              activePlayers: financials.confirmedPlayersCount,
              confirmedPlayersCount: financials.confirmedPlayersCount,
              verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
              availableSpaces: financials.availableSpaces,
              totalCardsSold: financials.totalCardsSold,
              totalCollectedEtb: financials.totalCollectedEtb,
              adeyShareEtb: financials.adeyShareEtb,
              winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
            };
          })
        );
      },
      (roomDoc) => {
        const nextStatus = roomDoc.status || 'countdown';
        const prevStatus = prevRoomStatusRef.current;
        if (
          (nextStatus === 'countdown' || nextStatus === 'waiting') &&
          typeof roomDoc.registrationDeadlineMs === 'number' &&
          roomDoc.registrationDeadlineMs > 0
        ) {
          roomDeadlineMsRef.current = roomDoc.registrationDeadlineMs;
          setCountdown(
            Math.max(
              0,
              Math.ceil(
                (roomDoc.registrationDeadlineMs - (Date.now() + serverClockOffsetMsRef.current)) /
                  1000
              )
            )
          );
        } else if (
          nextStatus === 'completed' &&
          typeof roomDoc.intermissionEndsAtMs === 'number' &&
          roomDoc.intermissionEndsAtMs > 0
        ) {
          roomDeadlineMsRef.current = roomDoc.intermissionEndsAtMs;
          setCountdown(
            Math.max(
              0,
              Math.ceil(
                (roomDoc.intermissionEndsAtMs - (Date.now() + serverClockOffsetMsRef.current)) /
                  1000
              )
            )
          );
        } else if (typeof roomDoc.countdownSeconds === 'number') {
          if (nextStatus !== 'countdown' && nextStatus !== 'waiting' && nextStatus !== 'completed') {
            roomDeadlineMsRef.current = 0;
          }
          setCountdown(roomDoc.countdownSeconds);
        }
        if (typeof roomDoc.cardPrice === 'number' && roomDoc.cardPrice > 0) {
          setCardPrice(roomDoc.cardPrice);
        }
        const confirmedPlayers = Number(
          roomDoc.confirmedPlayersCount ?? roomDoc.activePlayersCount ?? 0
        );
        const totalCards = Number(roomDoc.totalCardsSold ?? roomDoc.reservedCardsCount ?? 0);
        const financials = calculateAuthoritativeGameFinancials(
          confirmedPlayers,
          totalCards,
          Number(roomDoc.cardPrice || DEFAULT_GAME_RULES.defaultCardPrice)
        );
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? {
                  ...rm,
                  cardPrice: Number(roomDoc.cardPrice || rm.cardPrice),
                  status: nextStatus,
                  lifecycleStage: roomDoc.lifecycleStage || rm.lifecycleStage,
                  activePlayers: financials.confirmedPlayersCount,
                  confirmedPlayersCount: financials.confirmedPlayersCount,
                  verifiedPaidEntriesCount: Number(
                    roomDoc.verifiedPaidEntriesCount ?? financials.verifiedPaidEntriesCount
                  ),
                  availableSpaces: Number(roomDoc.availableSpaces ?? financials.availableSpaces),
                  totalCardsSold: financials.totalCardsSold,
                  totalCollectedEtb: Number(
                    roomDoc.totalCollectedEtb ?? financials.totalCollectedEtb
                  ),
                  adeyShareEtb: Number(roomDoc.adeyShareEtb ?? financials.adeyShareEtb),
                  winnersPrizePoolEtb: Number(
                    roomDoc.winnersPrizePoolEtb ?? financials.winnersPrizePoolEtb
                  ),
                }
              : rm
          )
        );
        if (prevStatus !== nextStatus) {
          void hydrateRoomState(activeRoomId);
        }
      },
      (connState) => {
        setFirestoreConnected(connState === 'online');
      },
      () => serverClockOffsetMsRef.current
    );

    const unsubGame = subscribeToGameState(`game_${activeRoomId}_live`, (liveGame) => {
      if (Array.isArray(liveGame.calledNumbers)) {
        setCalls(liveGame.calledNumbers);
      }
      if (
        liveGame.status === 'completed' &&
        Array.isArray(liveGame.winners) &&
        liveGame.winners.length > 0 &&
        prevRoomStatusRef.current !== 'completed'
      ) {
        void hydrateRoomState(activeRoomId);
        void hydratePlayerState();
      }
    });

    const unsubProfile = subscribeToUserProfile(fbUser.uid, (profile) => {
      if (typeof profile.demoBalanceEtb === 'number') {
        setDemoBalance(profile.demoBalanceEtb);
      }
      if (profile.language === 'am' || profile.language === 'en') {
        setLang(profile.language);
      }
      setPhoneVerified(profile.phoneVerified);
    });

    return () => {
      window.clearInterval(poll);
      unsubRoom();
      unsubGame();
      unsubProfile();
    };
  }, [fbUser, activeRoomId, hydratePlayerState, hydrateRoomState]);

  // Mirror game state to document.body.dataset.state
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (winnerModalOpen) {
      document.body.dataset.state = 'gameover';
    } else if (screen === 'game') {
      document.body.dataset.state = 'playing';
    } else {
      document.body.dataset.state = 'title';
    }
  }, [screen, winnerModalOpen]);

  // 2B. Vercel-compatible real-time synchronization: foreground/visibility/online re-hydration
  // plus authenticated player wallet & referral polling (paired with Firestore onSnapshot listeners above).
  useEffect(() => {
    const onForegroundSync = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void hydrateRoomState(activeRoomId);
      void hydratePlayerState();
    };
    window.addEventListener('focus', onForegroundSync);
    window.addEventListener('online', onForegroundSync);
    document.addEventListener('visibilitychange', onForegroundSync);

    const playerSyncPoll =
      activeSessionToken || fbUser
        ? window.setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void hydratePlayerState();
          }, 6000)
        : null;

    return () => {
      window.removeEventListener('focus', onForegroundSync);
      window.removeEventListener('online', onForegroundSync);
      document.removeEventListener('visibilitychange', onForegroundSync);
      if (playerSyncPoll !== null) {
        window.clearInterval(playerSyncPoll);
      }
    };
  }, [activeRoomId, activeSessionToken, fbUser, hydratePlayerState, hydrateRoomState]);

  // 2C. Referral deep-link synchronization for returning/cached sessions (e.g. ?start=ADEY-...)
  useEffect(() => {
    const rawStart = (user.startParam || '').trim().toUpperCase();
    if (
      autoAppliedStartRef.current ||
      !rawStart ||
      !/^ADEY-[1-9]\d*$/.test(rawStart) ||
      rawStart === referralCode.toUpperCase() ||
      referredByCode ||
      (!activeSessionToken && !fbUser && !serverVerifiedTelegramId)
    ) {
      return;
    }
    autoAppliedStartRef.current = true;
    void submitPlayerWalletAction({ action: 'apply_promo', code: rawStart }).then((res) => {
      if (res.ok) {
        void hydratePlayerState();
      }
    });
  }, [
    activeSessionToken,
    fbUser,
    hydratePlayerState,
    referralCode,
    referredByCode,
    serverVerifiedTelegramId,
    user.startParam,
  ]);

  // Server-authoritative countdown, intermission, and live next-ball synchronization computed strictly from
  // server deadlines & clock offset. Never starts rounds or draws numbers from the frontend; re-hydrates server
  // state immediately when registration, intermission, or next-ball draw deadlines are reached.
  useEffect(() => {
    let lastZeroHydrateAt = 0;
    const timer = window.setInterval(() => {
      const syncedNowMs = Date.now() + serverClockOffsetMsRef.current;
      if (activeRoom.status === 'live') {
        const ballDue =
          nextBallDrawAtMsRef.current <= 0 || syncedNowMs >= nextBallDrawAtMsRef.current;
        if (ballDue && Date.now() - lastZeroHydrateAt >= 900) {
          lastZeroHydrateAt = Date.now();
          void hydrateRoomState(activeRoomId);
        }
        return;
      }
      if (
        activeRoom.status !== 'countdown' &&
        activeRoom.status !== 'waiting' &&
        activeRoom.status !== 'completed'
      ) {
        return;
      }
      if (roomDeadlineMsRef.current > 0) {
        const remaining = Math.max(0, Math.ceil((roomDeadlineMsRef.current - syncedNowMs) / 1000));
        setCountdown(remaining);
        if (remaining === 0 && Date.now() - lastZeroHydrateAt >= 1000) {
          lastZeroHydrateAt = Date.now();
          void hydrateRoomState(activeRoomId);
        }
      } else if (Date.now() - lastZeroHydrateAt >= 1500) {
        lastZeroHydrateAt = Date.now();
        void hydrateRoomState(activeRoomId);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [activeRoom.status, activeRoomId, hydrateRoomState]);

  // Refresh player wallet & referral rewards immediately whenever opening Referral or Wallet tabs
  useEffect(() => {
    if (screen === 'referral' || screen === 'wallet' || screen === 'deposit' || screen === 'withdraw') {
      void hydratePlayerState();
    }
  }, [screen, hydratePlayerState]);

  // Auto-dismiss toast notifications after 3.2 seconds
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Immediately terminate calling & speech whenever winner is announced or round completes
  useEffect(() => {
    if (winnerModalOpen || activeRoom.status === 'completed') {
      setAutoCallerActive(false);
      soundFX.stopVoice();
    }
  }, [winnerModalOpen, activeRoom.status]);

  // Auto-Caller interval (restricted strictly to verified Admin/Host; regular players receive autonomous server ticks)
  const callNextNumberRef = useRef<() => void>(() => {});
  callNextNumberRef.current = () => {
    void handleCallNextNumber();
  };
  useEffect(() => {
    if (!isVerifiedAdmin || !autoCallerActive || winnerModalOpen || activeRoom.status !== 'live') {
      return;
    }
    const timer = window.setInterval(() => {
      callNextNumberRef.current();
    }, callerIntervalSec * 1000);
    return () => window.clearInterval(timer);
  }, [isVerifiedAdmin, autoCallerActive, winnerModalOpen, activeRoom.status, callerIntervalSec]);

  // Sync auto-marked numbers whenever autoMark is turned on or new balls are called
  useEffect(() => {
    if (!autoMark) return;
    const cardNums = new Set<number>();
    playerCards.forEach((c) => {
      c.grid.forEach((row) =>
        row.forEach((n) => {
          if (n > 0 && calls.includes(n)) {
            cardNums.add(n);
          }
        })
      );
    });
    setMarked((prev) => Array.from(new Set([...prev, ...cardNums])));
  }, [autoMark, calls, selectedCardIds]);

  // Speak newly called Bingo numbers in Amharic/English while in Live Game
  useEffect(() => {
    if (calls.length === 0) {
      lastSpokenBallRef.current = null;
      return;
    }
    const latest = calls[calls.length - 1];
    if (latest === lastSpokenBallRef.current) return;
    lastSpokenBallRef.current = latest;

    if (!sound || screen !== 'game' || winnerModalOpen || activeRoom.status === 'completed' || localWinnerSettledRoundRef.current) {
      return;
    }
    if (voiceEnabled) {
      void soundFX.speakBingoBall(latest, lang, true);
    } else {
      soundFX.playBallCall(true);
    }
  }, [activeRoom.status, calls, lang, screen, sound, voiceEnabled, winnerModalOpen]);

  // Handler: Authenticate via Telegram Mini App initData (/api/telegram/auth)
  async function handleSignInGoogle() {
    const launchCtx = await waitForTelegramWebAppInitData(500);
    const rawInitData = launchCtx.initData;
    const incomingAuthDate = rawInitData ? extractInitDataAuthDate(rawInitData) : 0;

    // Avoid self-inflicted 409 replay_detected if an active verified session already exists
    if (activeSessionTokenRef.current && serverVerifiedTelegramId) {
      const refreshed = await hydratePlayerState();
      if (refreshed) {
        setTelegramBackendStatus(
          `✓ Authenticated on Server: TG User #${serverVerifiedTelegramId}`
        );
        setToast(
          lang === 'am'
            ? `የቴሌግራም መለያዎ (#${serverVerifiedTelegramId}) ቀድሞውኑ ተገናኝቷል`
            : `Already authenticated with Telegram (#${serverVerifiedTelegramId})`
        );
        return;
      }
    }

    if (!rawInitData) {
      const errCode = launchCtx.launchedInTelegram ? 'missing_init_data' : 'not_in_telegram';
      recordAuthDiagnostics({
        launchedInTelegram: launchCtx.launchedInTelegram,
        initDataPresent: false,
        telegramHashValid: false,
        telegramUserIdExtracted: false,
        backendAuthSucceeded: false,
        firebaseAuthSucceeded: Boolean(auth.currentUser),
        errorCode: errCode,
      });
      setTelegramBackendStatus(
        launchCtx.launchedInTelegram
          ? `Auth failed (400): ${errCode} — Reopen via @AdeyBingoGameBot Menu or Play button.`
          : `Opened outside Telegram (${errCode}) — Launch inside @AdeyBingoGameBot Mini App.`
      );
      setToast(formatTelegramAuthErrorMessage(errCode, lang));
      return;
    }

    try {
      const resp = await fetch('/api/telegram/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: rawInitData,
          ...(user.startParam ? { startParam: user.startParam } : {}),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) {
        const verifiedId = Number(
          data.verifiedTelegramId ?? data.profile?.telegramUserId ?? data.telegramUser?.id
        );
        if (Number.isInteger(verifiedId) && verifiedId > 0) {
          setServerVerifiedTelegramId(verifiedId);
        }
        syncUserIdentityFromServer({
          telegramUserId: Number.isInteger(verifiedId) && verifiedId > 0 ? verifiedId : undefined,
          displayName: data.displayName,
          firstName: data.profile?.firstName ?? data.telegramUser?.first_name,
          lastName: data.profile?.lastName ?? data.telegramUser?.last_name,
          username: data.profile?.username ?? data.telegramUser?.username,
          language:
            data.profile?.language === 'en'
              ? 'en'
              : data.profile?.language === 'am'
                ? 'am'
                : undefined,
        });
        const verifiedAdminFlag = Boolean(data.isAdmin === true || data.role === 'admin');
        setIsVerifiedAdmin(verifiedAdminFlag);
        if (data.sessionToken) {
          setSessionBearerToken(data.sessionToken);
          setActiveSessionToken(data.sessionToken);
          if (Number.isInteger(verifiedId) && verifiedId > 0) {
            savePersistedTelegramSession({
              sessionToken: data.sessionToken,
              verifiedTelegramId: verifiedId,
              authDate: incomingAuthDate,
              expiresAtMs: Date.now() + 55 * 60 * 1000,
            });
          }
        }
        const profileBalance = data.profile?.demoBalanceEtb ?? data.demoBalanceEtb;
        if (typeof profileBalance === 'number') {
          setDemoBalance(profileBalance);
        }
        const profilePhoneVerified = Boolean(data.profile?.phoneVerified ?? data.phoneVerified ?? false);
        setPhoneVerified(profilePhoneVerified);
        const profileLang = data.profile?.language;
        if (profileLang === 'am' || profileLang === 'en') {
          setLang(profileLang);
        }
        if (data.referralApplied?.applied) {
          autoAppliedStartRef.current = true;
        }
        let fbAuthOk = Boolean(auth.currentUser);
        if (data.customToken) {
          try {
            await signInWithCustomToken(auth, data.customToken);
            fbAuthOk = true;
          } catch (fbErr) {
            fbAuthOk = false;
            console.warn('[adeybingo/telegram-auth] Firebase custom token sign-in fallback:', fbErr);
          }
        }
        const phonePending = !profilePhoneVerified && !verifiedAdminFlag;
        recordAuthDiagnostics({
          launchedInTelegram: true,
          initDataPresent: true,
          telegramHashValid: true,
          telegramUserIdExtracted: Number.isInteger(verifiedId) && verifiedId > 0,
          backendAuthSucceeded: true,
          firebaseAuthSucceeded: fbAuthOk,
          phoneVerificationPending: phonePending,
          errorCode: phonePending ? 'phone_verification_required' : null,
        });
        await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoomId)]);
        const displayName =
          data.displayName ||
          data.profile?.firstName ||
          data.telegramUser?.first_name ||
          user.firstName;
        setTelegramBackendStatus(
          `✓ Authenticated on Server: TG User #${verifiedId || data.telegramUser?.id || ''}`
        );
        setToast(
          lang === 'am'
            ? `በቴሌግራም Mini App ተረጋግጧል (${displayName})`
            : `Authenticated via Telegram Mini App (${displayName})`
        );
      } else {
        const statusCode = data.statusCode || resp.status;
        const errCode = String(
          data.reason || data.error || (resp.status >= 500 ? 'backend_http_error' : 'auth_rejected')
        );
        const serverDiag = data.authDiagnostics as Partial<TelegramClientAuthDiagnostics> | undefined;
        recordAuthDiagnostics({
          launchedInTelegram: launchCtx.launchedInTelegram,
          initDataPresent: true,
          telegramHashValid: serverDiag?.telegramHashValid ?? (errCode === 'replay_detected'),
          telegramUserIdExtracted: serverDiag?.telegramUserIdExtracted ?? false,
          backendAuthSucceeded: false,
          firebaseAuthSucceeded: false,
          phoneVerificationPending: serverDiag?.phoneVerificationPending ?? false,
          errorCode: errCode,
        });
        const category = data.diagnostics?.failureCategory
          ? ` [${data.diagnostics.failureCategory}]`
          : '';
        setTelegramBackendStatus(
          `Server response (${statusCode}): ${errCode}${category} — ${data.message || 'Verification failed'}`
        );
        setToast(formatTelegramAuthErrorMessage(errCode, lang, data.message));
      }
    } catch (err) {
      recordAuthDiagnostics({
        launchedInTelegram: launchCtx.launchedInTelegram,
        initDataPresent: true,
        backendAuthSucceeded: false,
        errorCode: 'backend_network_error',
      });
      setToast(
        formatTelegramAuthErrorMessage(
          'backend_network_error',
          lang,
          err instanceof Error ? err.message : undefined
        )
      );
    }
  }

  // Handler: Firebase Sign-Out
  async function handleSignOutFirebase() {
    await signOutFromFirebase();
    savePersistedTelegramSession(null);
    setActiveSessionToken('');
    setServerVerifiedTelegramId(null);
    setDemoBalance(0);
    setWinningsBalance(0);
    setTransactions([]);
    setDepositRequests([]);
    setPayoutRequests([]);
    setReferrals([]);
    setTickets([]);
    setToast(lang === 'am' ? 'ከFirebase ወጥተዋል' : 'Signed out from Firebase');
  }

  // Handler: Validate Telegram Mini App initData on trusted backend (/api/telegram/validate-init-data)
  async function handleValidateTelegramInitData() {
    const { initData: rawInitData } = await waitForTelegramWebAppInitData(500);

    try {
      const resp = await fetch('/api/telegram/validate-init-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: rawInitData }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.verified) {
        const verifiedId = Number(data.verifiedTelegramId ?? data.telegramUser?.id);
        if (Number.isInteger(verifiedId) && verifiedId > 0) {
          setServerVerifiedTelegramId(verifiedId);
        }
        setTelegramBackendStatus(
          `✓ Verified on Server: TG User #${verifiedId || data.telegramUser?.id} (hash ${String(
            data.dataCheckHash
          ).slice(0, 12)}...)`
        );
        setToast(
          lang === 'am'
            ? 'የቴሌግራም initData በሰርቨር ተረጋግጧል!'
            : 'Telegram initData cryptographically verified on server!'
        );
      } else if (resp.status === 409 && serverVerifiedTelegramId) {
        setTelegramBackendStatus(
          `✓ Verified on Server: TG User #${serverVerifiedTelegramId} (initData already verified in active session)`
        );
        setToast(
          lang === 'am'
            ? `የቴሌግራም መለያ ቁጥር #${serverVerifiedTelegramId} በዚህ ክፍለ ጊዜ ተረጋግጧል`
            : `Telegram ID #${serverVerifiedTelegramId} is already verified in this session`
        );
      } else {
        const statusCode = data.statusCode || resp.status;
        const category = data.diagnostics?.failureCategory
          ? ` [${data.diagnostics.failureCategory}]`
          : '';
        setTelegramBackendStatus(
          `Server response (${statusCode}): ${data.reason || data.error || 'error'}${category} — ${data.message || ''}`
        );
        setToast(data.message || 'Telegram initData check completed');
      }
    } catch (err) {
      setTelegramBackendStatus(
        `Backend error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Handler: Synchronize Native Telegram Contact Verification State (never submits typed phone numbers)
  async function handleVerifyPhone(
    _cleanedPhone: string,
    method: 'telegram_contact' | 'sms_otp_demo'
  ) {
    const token = await getActiveBearerToken();
    if (!token) {
      soundFX.playError(sound);
      setToast(
        lang === 'am'
          ? 'ስልክ ቁጥር ለማረጋገጥ መጀመሪያ በቴሌግራም Mini App ይግቡ'
          : 'Authenticate inside Telegram Mini App to verify your phone number.'
      );
      return;
    }
    if (method !== 'telegram_contact') {
      soundFX.playError(sound);
      setToast(
        lang === 'am'
          ? 'በጽሁፍ የተጻፈ ስልክ ቁጥር አይረጋገጥም — እባክዎ የቴሌግራም ስልክ ማጋራት (Share Contact) ቁልፍን ይጠቀሙ'
          : 'Typed phone numbers are not verified — please use native Telegram Contact Sharing.'
      );
      return;
    }
    // Native Telegram contact sharing delivers a signed message.contact directly to /api/telegram/webhook.
    // Re-hydrate the player profile from the authoritative server to reflect the verified phone state.
    await hydratePlayerState();
    window.setTimeout(() => {
      void hydratePlayerState();
    }, 2500);
  }

  // Handler: Server-Authoritative Call Next Ball (POST /api/game/draw-ball)
  async function handleCallNextNumber() {
    if (
      winnerModalOpen ||
      activeRoom.status !== 'live' ||
      localWinnerSettledRoundRef.current
    ) {
      setAutoCallerActive(false);
      return;
    }
    const token = await getActiveBearerToken();
    if (!token) {
      setAutoCallerActive(false);
      soundFX.playError(sound);
      setToast(
        lang === 'am'
          ? 'ቁጥር ለመጥራት በቴሌግራም Mini App መግባት ያስፈልጋል'
          : 'Authentication required to request server ball draws.'
      );
      return;
    }
    try {
      const res = await drawBallViaServerApi({
        roomId: activeRoom.id,
        gameId: `game_${activeRoom.id}_live`,
        callerTelegramId: serverVerifiedTelegramId ?? 0,
      });
      triggerHaptic('light');
      setCalls(res.calledNumbers);
    } catch (err) {
      setAutoCallerActive(false);
      soundFX.playError(sound);
      setToast(err instanceof Error ? err.message : 'Server ball draw failed');
    }
  }

  // Handler: Toggle card selection (1..600, max 4) strictly via server-authoritative POST /api/cards/reserve
  async function handleToggleCardId(cardId: number) {
    if (isCardsLocked) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? '60 ሰከንዱ አልቋል — ዙሩ እስኪያልቅ ካርድ መምረጥ አይቻልም'
          : 'Round is live — cards are locked until this game finishes'
      );
      return;
    }
    const token = await getActiveBearerToken();
    if (!token) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? 'ካርድ ለመምረጥ እባክዎ በቴሌግራም Mini App ይግቡ'
          : 'Please open inside Telegram Mini App to reserve cards with your verified balance.'
      );
      return;
    }

    const isRemoving = selectedCardIds.includes(cardId);
    if (!isRemoving && demoBalance < cardPrice) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? `ካርድ ለመምረጥ በቂ ቀሪ ሂሳብ የለዎትም (${demoBalance.toFixed(2)} ብር)! ጓደኛ ይጋብዙ (+20 ብር) ወይም ገንዘብ ያስገቡ።`
          : `Insufficient balance (${demoBalance.toFixed(2)} ETB)! Invite friends (+20 ETB) or deposit to play.`
      );
      return;
    }

    const previousCardIds = [...selectedCardIds];
    const result = toggleCardSelection(
      selectedCardIds,
      cardId,
      activeRoom.takenCardIds,
      DEFAULT_GAME_RULES.maxCardsPerPlayer,
      DEFAULT_GAME_RULES.maxCardsPerRoom
    );
    if (!result.ok) {
      soundFX.playError(sound);
      triggerHaptic('error');
      if (result.reason === 'max_limit_reached') {
        setToast(
          lang === 'am' ? 'በአንድ ተጫዋች ቢበዛ 4 ካርዶች ብቻ ይፈቀዳሉ' : 'Maximum 4 cards per player'
        );
      } else if (result.reason === 'taken_by_other') {
        setToast(
          lang === 'am' ? `ካርድ ${cardId} በሌላ ተጫዋች ተይዟል` : `Card ${cardId} is already taken`
        );
      }
      return;
    }

    try {
      const txRes = await toggleCardReservationAtomic({
        roomId: activeRoom.id,
        cardId,
        uid: fbUser?.uid,
        displayName: fbUser?.displayName || `${user.firstName} ${user.lastName || ''}`.trim(),
        telegramUserId: serverVerifiedTelegramId ? `tg_${serverVerifiedTelegramId}` : '',
      });
      soundFX.playDaub(sound);
      triggerHaptic('light');
      setSelectedCardIds(txRes.updatedCardIds);
      if (typeof txRes.updatedBalanceEtb === 'number') {
        setDemoBalance(txRes.updatedBalanceEtb);
      }
      setToast(
        lang === 'am'
          ? `ካርድ #${cardId} ${txRes.action === 'reserved' ? `ተመርጧል (-${cardPrice} ብር)` : `ተመልሷል (+${cardPrice} ብር)`}`
          : `Card #${cardId} ${txRes.action === 'reserved' ? `selected (-${cardPrice} ETB)` : `released (+${cardPrice} ETB)`}`
      );
      await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoom.id)]);
    } catch (err) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setSelectedCardIds(previousCardIds);
      setToast(err instanceof Error ? err.message : 'Card reservation rejected by server');
    }
  }

  async function handleClearSelectedCards() {
    if (isCardsLocked || selectedCardIds.length === 0) return;
    const token = await getActiveBearerToken();
    if (!token) {
      soundFX.playError(sound);
      setToast(
        lang === 'am'
          ? 'ካርድ ለመሰረዝ በቴሌግራም Mini App ይግቡ'
          : 'Authenticate inside Telegram Mini App to modify reserved cards.'
      );
      return;
    }
    let releasedCount = 0;
    for (const cid of [...selectedCardIds]) {
      try {
        await toggleCardReservationAtomic({
          roomId: activeRoom.id,
          cardId: cid,
          action: 'release',
        });
        releasedCount += 1;
      } catch {
        // Stop on first server error and re-sync authoritative state
        break;
      }
    }
    await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoom.id)]);
    if (releasedCount > 0) {
      const refund = releasedCount * cardPrice;
      setToast(
        lang === 'am'
          ? `የተመረጡ ካርዶች ተሰርዘዋል (+${refund.toFixed(2)} ብር ተመልሷል)`
          : `Cleared selected cards (+${refund.toFixed(2)} ETB refunded)`
      );
    }
  }

  // Handler: Quick pick N available cards atomically via server /api/cards/reserve
  async function handleQuickPickCards(targetCount: number) {
    if (isCardsLocked) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? '60 ሰከንዱ አልቋል — ዙሩ እስኪያልቅ ካርድ መምረጥ አይቻልም'
          : 'Round is live — cards are locked until this game finishes'
      );
      return;
    }
    const token = await getActiveBearerToken();
    if (!token) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? 'ካርድ ለመምረጥ እባክዎ በቴሌግራም Mini App ይግቡ'
          : 'Please open inside Telegram Mini App to reserve cards.'
      );
      return;
    }

    const totalPoolEtb = demoBalance + selectedCardIds.length * cardPrice;
    const maxAffordable = Math.floor(totalPoolEtb / cardPrice);
    if (maxAffordable <= 0) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? `ካርድ ለመምረጥ በቂ ቀሪ ሂሳብ የለዎትም (${demoBalance.toFixed(2)} ብር)! ጓደኛ ይጋብዙ (+20 ብር) ወይም ገንዘብ ያስገቡ።`
          : `Insufficient balance (${demoBalance.toFixed(2)} ETB)! Invite friends (+20 ETB) or deposit to play.`
      );
      return;
    }
    const clamped = Math.max(
      1,
      Math.min(DEFAULT_GAME_RULES.maxCardsPerPlayer, maxAffordable, targetCount)
    );

    // Release excess cards if targetCount < current count
    if (selectedCardIds.length > clamped) {
      for (const cid of selectedCardIds.slice(clamped)) {
        await toggleCardReservationAtomic({
          roomId: activeRoom.id,
          cardId: cid,
          action: 'release',
        }).catch(() => {});
      }
    }

    const currentIds = new Set(selectedCardIds.slice(0, clamped));
    const available: number[] = [];
    for (let id = 1; id <= DEFAULT_GAME_RULES.maxCardsPerRoom; id++) {
      if (!activeRoom.takenCardIds.includes(id) && !currentIds.has(id)) {
        available.push(id);
      }
    }
    const newlyReserved: number[] = [];
    while (currentIds.size < clamped && available.length > 0) {
      const idx = Math.floor(Math.random() * available.length);
      const candidateId = available[idx];
      available.splice(idx, 1);
      try {
        await toggleCardReservationAtomic({
          roomId: activeRoom.id,
          cardId: candidateId,
          action: 'reserve',
        });
        currentIds.add(candidateId);
        newlyReserved.push(candidateId);
      } catch {
        // Skip taken/rejected card and try another
      }
    }
    await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoom.id)]);
    const finalPicked = Array.from(currentIds).sort((a, b) => a - b);
    if (finalPicked.length > 0) {
      soundFX.playDaub(sound);
      setToast(
        lang === 'am'
          ? `${finalPicked.length} ካርድ ተመርጧል (${finalPicked.join(', ')})`
          : `Selected ${finalPicked.length} card${finalPicked.length === 1 ? '' : 's'} (${finalPicked.join(', ')})`
      );
    } else if (newlyReserved.length === 0) {
      soundFX.playError(sound);
    }
  }

  // Handler: Add 1 card quickly (up to 4)
  function handleAddQuickCard() {
    if (isCardsLocked) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? '60 ሰከንዱ አልቋል — ዙሩ እስኪያልቅ ካርድ መምረጥ አይቻልም'
          : 'Round is live — cards are locked until this game finishes'
      );
      return;
    }
    if (demoBalance < cardPrice) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? `ተጨማሪ ካርድ ለመምረጥ በቂ ሂሳብ የለዎትም (${demoBalance.toFixed(2)} ብር)! ጓደኛ ይጋብዙ (+20 ብር) ወይም ገንዘብ ያስገቡ።`
          : `Insufficient balance (${demoBalance.toFixed(2)} ETB) for another card! Invite friends (+20 ETB) or deposit.`
      );
      return;
    }
    if (selectedCardIds.length >= DEFAULT_GAME_RULES.maxCardsPerPlayer) {
      soundFX.playError(sound);
      setToast(
        lang === 'am' ? 'በአንድ ተጫዋች ቢበዛ 4 ካርዶች ብቻ ይፈቀዳሉ' : 'Maximum 4 cards per player'
      );
      return;
    }
    for (let id = 1; id <= DEFAULT_GAME_RULES.maxCardsPerRoom; id++) {
      if (!selectedCardIds.includes(id) && !activeRoom.takenCardIds.includes(id)) {
        void handleToggleCardId(id);
        return;
      }
    }
  }

  // Handler: Manual cell marking on a Bingo card
  function handleToggleCellMark(num: number) {
    if (num === 0) return;
    if (!calls.includes(num)) {
      soundFX.playError(sound);
      triggerHaptic('error');
      setToast(
        lang === 'am'
          ? `ቁጥር ${num} ገና አልተጠራም!`
          : `That number (${num}) has not been called yet`
      );
      return;
    }
    soundFX.playDaub(sound);
    triggerHaptic('light');
    setMarked((prev) => (prev.includes(num) ? prev.filter((x) => x !== num) : [...prev, num]));
  }

  // Handler: Verify BINGO claim across all player cards via POST /api/game/verify-winner
  async function handleClaimBingo() {
    if (playerCards.length === 0) {
      soundFX.playError(sound);
      setToast(lang === 'am' ? 'መጀመሪያ ቢያንስ 1 ካርድ ይምረጡ!' : 'Please select at least 1 card first!');
      return;
    }

    for (const card of playerCards) {
      const winCheck = checkCardWin(card, marked, calls, true);
      if (winCheck.won) {
        const token = await getActiveBearerToken();
        if (!token) {
          soundFX.playError(sound);
          setToast(
            lang === 'am'
              ? 'ሽልማት ለማረጋገጥ በቴሌግራም Mini App መግባት ያስፈልጋል።'
              : 'Telegram Mini App authentication is required to verify and credit wins.'
          );
          return;
        }

        let serverPrize = 0;
        try {
          const verification = await verifyWinnerViaServerApi({
            roomId: activeRoom.id,
            gameId: `game_${activeRoom.id}_live`,
            cardId: card.id,
            markedNumbers: marked,
            calledNumbers: calls,
            claimantTelegramId: serverVerifiedTelegramId ?? 0,
            playerName: `${user.firstName} ${user.lastName || ''}`.trim(),
          });
          if (!verification.verified) {
            soundFX.playError(sound);
            triggerHaptic('error');
            setToast(
              verification.message || verification.reason || 'Server rejected winner verification'
            );
            return;
          }
          serverPrize = Number(verification.demoPrizeEtb ?? 0);
        } catch (err) {
          soundFX.playError(sound);
          setToast(err instanceof Error ? err.message : 'Server winner verification failed');
          return;
        }

        localWinnerSettledRoundRef.current = true;
        setAutoCallerActive(false);
        soundFX.stopVoice();
        soundFX.playWinFanfare(sound);
        triggerHaptic('success');
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoom.id ? { ...rm, status: 'completed', countdownSeconds: 0 } : rm
          )
        );
        setActiveWinResult(winCheck);
        setLastVerifiedPrizeEtb(serverPrize);
        setWinnerModalOpen(true);
        await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoom.id)]);

        setToast(
          lang === 'am'
            ? `እንኳን ደስ አለዎት! በካርድ #${card.id} BINGO አሸንፈዋል!`
            : `BINGO Verified on Card #${card.id}!`
        );
        return;
      }
    }

    const firstCheck = checkCardWin(playerCards[0], marked, calls, true);
    const missing = firstCheck.missingNumbers ?? [];
    soundFX.playError(sound);
    triggerHaptic('error');
    setToast(
      lang === 'am'
        ? `ገና መስመር አልሞላም! ለማሸነፍ የሚቀሩ ቁጥሮች፦ ${missing.join(', ')}`
        : `Not a completed Bingo line yet! Closest line needs: ${missing.join(', ')}`
    );
  }

  // Handler: Reset live round strictly via server-authoritative POST /api/game/reset-round
  async function handleResetRound() {
    localWinnerSettledRoundRef.current = false;
    soundFX.stopVoice();
    const token = await getActiveBearerToken();
    if (!token) {
      soundFX.playError(sound);
      setToast(
        lang === 'am'
          ? 'ዙር ለመጀመር በቴሌግራም Mini App መግባት ያስፈልጋል'
          : 'Authentication required to reset the game round.'
      );
      return;
    }
    try {
      await resetRoundViaServerApi({
        roomId: activeRoom.id,
        gameId: `game_${activeRoom.id}_live`,
      });
      await hydrateRoomState(activeRoom.id);
    } catch (err) {
      soundFX.playError(sound);
      setToast(err instanceof Error ? err.message : 'Server round reset failed');
      return;
    }
    setAutoCallerActive(false);
    setWinnerModalOpen(false);
    setActiveWinResult(null);
    setLastVerifiedPrizeEtb(0);
    setRoundWinners([]);
    setWinningCardOverride(null);
    setCalls([]);
    setMarked([]);
    setToast(lang === 'am' ? 'ዙሩ እንደገና ተጀምሯል' : 'Round reset');
  }

  // Handler: Enter Live Game from Lobby/Card Picker (strictly requires at least 1 selected card)
  async function handleEnterLiveGame() {
    if (selectedCardIds.length === 0) {
      soundFX.playError(sound);
      triggerHaptic('error');
      if (demoBalance < cardPrice) {
        setToast(
          lang === 'am'
            ? 'ያለ ቀሪ ሂሳብ እና ካርድ መጫወት አይቻልም! ጓደኛ ይጋብዙ (+20 ብር) ወይም ገንዘብ ያስገቡ።'
            : 'Cannot play without balance & card! Invite friends (+20 ETB) or deposit in Wallet.'
        );
      } else {
        setToast(
          lang === 'am'
            ? 'ያለ ካርድ መጫወት አይቻልም! እባክዎ መጀመሪያ ከ1–600 ቢያንስ 1 ካርድ ይምረጡ።'
            : 'Cannot play without a card! Please select at least 1 card (1–600) first.'
        );
      }
      return;
    }

    void hydrateRoomState(activeRoom.id);
    setScreen('game');
    setToast(lang === 'am' ? `ወደ ${activeRoom.nameAm} ገብተዋል!` : `Joined ${activeRoom.nameEn}!`);
  }

  function handleSelectRoom(nextRoomId: string) {
    if (nextRoomId === activeRoomId) return;
    localWinnerSettledRoundRef.current = false;
    roomDeadlineMsRef.current = 0;
    nextBallDrawAtMsRef.current = 0;
    hydratedRoomIdRef.current = '';
    prevRoomStatusRef.current = 'waiting';
    lastRoundNumberRef.current = 0;
    activeRoomIdRef.current = nextRoomId;
    setSelectedCardIds([]);
    setCalls([]);
    setMarked([]);
    setWinnerModalOpen(false);
    setActiveWinResult(null);
    setRoundWinners([]);
    setWinningCardOverride(null);
    setActiveRoomId(nextRoomId);
    void hydrateRoomState(nextRoomId);
  }

  // Handler: Apply Promo or Referral Code strictly via persistent server POST /api/player/wallet
  async function handleApplyPromoCode(code: string): Promise<{ ok: boolean; message: string }> {
    const cleaned = code.trim().toUpperCase();
    const res = await submitPlayerWalletAction({ action: 'apply_promo', code: cleaned });
    if (res.ok) {
      soundFX.playWinFanfare(sound);
      triggerHaptic('success');
      await hydratePlayerState();
      const inviterBonus = Number(res.inviterBonusEtb ?? 20);
      const msg =
        lang === 'am'
          ? `የግብዣ ኮዱ ተረጋግጧል! ለጋባዡ +${inviterBonus.toFixed(0)} ብር ሽልማት ተሰጥቷል።`
          : `Referral code verified! Inviter rewarded +${inviterBonus.toFixed(0)} ETB.`;
      setToast(msg);
      return { ok: true, message: msg };
    }

    soundFX.playError(sound);
    const errMsg =
      res.message ||
      (lang === 'am'
        ? 'ትክክለኛ የጓደኛ ግብዣ ኮድ ያስገቡ (ለምሳሌ ADEY-1002)'
        : 'Enter a valid friend referral code (e.g. ADEY-1002)');
    setToast(errMsg);
    return { ok: false, message: errMsg };
  }

  // Handler: Submit Manual Payment Deposit Receipt via POST /api/player/wallet
  async function handleSubmitDepositRequest(
    amount: number,
    provider: string,
    receiptReference: string,
    receiptProof: string
  ) {
    const res = await submitPlayerWalletAction({
      action: 'deposit_request',
      amountEtb: amount,
      provider,
      receiptReference,
      referenceCode: receiptReference,
      receiptProof,
    });
    if (res.ok) {
      soundFX.playDaub(sound);
      await hydratePlayerState();
      setToast(
        lang === 'am'
          ? `የ ${amount.toFixed(2)} ETB የክፍያ ደረሰኝ (${receiptReference}) ለአስተዳዳሪ ማረጋገጫ ተልኳል`
          : `Manual deposit receipt (${receiptReference}) for ${amount.toFixed(2)} ETB submitted for admin verification`
      );
      setScreen('wallet');
      return;
    }
    soundFX.playError(sound);
    const errMsg =
      res.message || (lang === 'am' ? 'የተቀማጭ ጥያቄ አልተሳካም' : 'Deposit request failed');
    setToast(errMsg);
    throw new Error(errMsg);
  }

  // Handler: Submit Withdrawal Request via POST /api/player/wallet
  async function handleSubmitWithdrawRequest(amount: number, method: string): Promise<boolean> {
    const res = await submitPlayerWalletAction({
      action: 'withdraw_request',
      amountEtb: amount,
      method,
    });
    if (res.ok) {
      soundFX.playDaub(sound);
      await hydratePlayerState();
      setToast(
        lang === 'am'
          ? `የ ${amount.toFixed(2)} ETB የወጪ ጥያቄ (${method}) ተመዝግቧል`
          : `Withdrawal request of ${amount.toFixed(2)} ETB (${method}) submitted`
      );
      setScreen('wallet');
      return true;
    }
    soundFX.playError(sound);
    setToast(res.message || (lang === 'am' ? 'የወጪ ጥያቄ አልተሳካም' : 'Withdrawal request failed'));
    return false;
  }

  // Handler: Persistent Support Ticket via POST /api/player/wallet
  async function handleSubmitSupportTicket(category: string, subject: string, message: string) {
    const res = await submitPlayerWalletAction({
      action: 'support_ticket',
      category,
      subject,
      message,
    });
    if (res.ok && res.ticket) {
      soundFX.playDaub(sound);
      setTickets((prev) => [res.ticket!, ...prev.filter((t) => t.id !== res.ticket!.id)]);
      await hydratePlayerState();
      setToast(
        lang === 'am'
          ? `የድጋፍ ጥያቄዎ (${res.ticket.id}) ተልኳል!`
          : `Support ticket (${res.ticket.id}) submitted!`
      );
      return;
    }
    soundFX.playError(sound);
    setToast(
      res.message ||
        (lang === 'am'
          ? 'የድጋፍ ጥያቄ ለመላክ መጀመሪያ በቴሌግራም Mini App ይግቡ'
          : 'Authenticate inside Telegram Mini App to submit a support ticket.')
    );
  }

  const winningCardObj =
    playerCards.find((c) => c.id === activeWinResult?.cardId) ??
    playerCards[0] ??
    generateDeterministicCard(1);

  function handleChangeLanguage(nextLangOrUpdater: Language | ((prev: Language) => Language)) {
    const nextLang =
      typeof nextLangOrUpdater === 'function' ? nextLangOrUpdater(lang) : nextLangOrUpdater;
    setLang(nextLang);
    if (fbUser?.uid || (serverVerifiedTelegramId !== null && serverVerifiedTelegramId > 0)) {
      void syncLanguagePreference(nextLang, fbUser?.uid, serverVerifiedTelegramId ?? undefined);
    }
  }

  // Referral attribution handled in effect 2C above.

  // Prevent authenticated ordinary players from entering the private /admin dashboard
  useEffect(() => {
    if (isAdminRoute && serverVerifiedTelegramId !== null && !isVerifiedAdmin) {
      window.history.replaceState({}, '', '/');
      setIsAdminRoute(false);
    }
  }, [isAdminRoute, serverVerifiedTelegramId, isVerifiedAdmin]);

  if (isAdminRoute && (isVerifiedAdmin || serverVerifiedTelegramId === null)) {
    return (
      <AdminDashboardScreen
        lang={lang}
        onToggleLang={() => handleChangeLanguage((l) => (l === 'am' ? 'en' : 'am'))}
        onReturnToPlayerApp={() => {
          window.history.pushState({}, '', '/');
          setIsAdminRoute(false);
        }}
      />
    );
  }

  const isAuthenticatedPlayer =
    fbUser !== null || (serverVerifiedTelegramId !== null && serverVerifiedTelegramId > 0);
  const mustVerifyPhoneBeforePlaying =
    isAuthenticatedPlayer && !isVerifiedAdmin && !phoneVerified;

  if (mustVerifyPhoneBeforePlaying) {
    return (
      <div className="app min-h-screen flex flex-col items-center justify-center p-4 bg-[#FFFDF7]">
        <div
          data-testid="phone-verification-gate"
          className="w-full max-w-md rounded-2xl bg-white border border-[#E7EDE8] p-5 shadow-[0_8px_28px_rgba(24,51,38,0.08)] space-y-4 text-center"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#159447]">
              🌼 ADEYBINGO
            </span>
            <button
              type="button"
              onClick={() => handleChangeLanguage((l) => (l === 'am' ? 'en' : 'am'))}
              className="px-2.5 py-1 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-extrabold text-[#183326]"
            >
              {lang === 'am' ? '🌐 English' : '🌐 አማርኛ'}
            </button>
          </div>

          <div className="rounded-xl bg-[#E6F6EB] border border-[#159447]/30 px-3 py-2 text-[11px] font-bold text-[#08743A]">
            {lang === 'am'
              ? `✓ የቴሌግራም መለያ ተረጋግጧል (${user.firstName}${serverVerifiedTelegramId ? ` · #${serverVerifiedTelegramId}` : ''})`
              : `✓ Telegram Authenticated (${user.firstName}${serverVerifiedTelegramId ? ` · #${serverVerifiedTelegramId}` : ''})`}
          </div>

          <div className="space-y-2">
            <h1 className="font-['Outfit'] text-xl font-extrabold text-[#183326]">
              {lang === 'am'
                ? '📱 የስልክ ቁጥር ማረጋገጫ ያስፈልጋል'
                : '📱 Phone Verification Required'}
            </h1>
            <p className="text-xs text-[#4B5E52] leading-relaxed">
              {lang === 'am'
                ? 'ከመጫወትዎ በፊት መለያዎን ለማረጋገጥ የቴሌግራም ስልክ ቁጥርዎን ያጋሩ።'
                : 'Please share your Telegram phone number to verify your account before playing.'}
            </p>
            <p className="text-[11px] text-[#68776D] leading-relaxed">
              {lang === 'am'
                ? 'Please share your Telegram phone number to verify your account before playing.'
                : 'ከመጫወትዎ በፊት መለያዎን ለማረጋገጥ የቴሌግራም ስልክ ቁጥርዎን ያጋሩ።'}
            </p>
          </div>

          <div className="space-y-2 pt-1">
            {authDiagnostics.launchedInTelegram && (
              <button
                type="button"
                disabled={onboardingContactBusy}
                onClick={async () => {
                  setOnboardingContactBusy(true);
                  try {
                    const res = await requestTelegramContact();
                    if (res.supported && res.sent) {
                      setToast(
                        lang === 'am'
                          ? 'ስልክ ቁጥርዎ ተልኳል — ማረጋገጫዎን በማዘመን ላይ...'
                          : 'Contact shared — refreshing verification status...'
                      );
                      window.setTimeout(() => void hydratePlayerState(), 1200);
                    } else if (!res.supported) {
                      setToast(
                        lang === 'am'
                          ? 'እባክዎ ከታች ባለው ቁልፍ በ@AdeyBingoGameBot ስልክ ቁጥርዎን ያጋሩ።'
                          : 'Please tap the @AdeyBingoGameBot button below to share your phone contact.'
                      );
                    }
                  } finally {
                    setOnboardingContactBusy(false);
                  }
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-sm font-extrabold shadow-sm disabled:opacity-60"
              >
                📱 {onboardingContactBusy ? '...' : 'ስልክ ቁጥር አጋራ | Share Contact'}
              </button>
            )}
            <a
              href="https://t.me/AdeyBingoGameBot?start=verify"
              target="_blank"
              rel="noopener noreferrer"
              className={`w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-extrabold shadow-sm ${
                authDiagnostics.launchedInTelegram
                  ? 'bg-[#E6F6EB] border border-[#159447]/40 text-[#08743A]'
                  : 'bg-gradient-to-r from-[#159447] to-[#08743A] text-white'
              }`}
            >
              🤖 {lang === 'am' ? 'በ @AdeyBingoGameBot ያረጋግጡ' : 'Verify on @AdeyBingoGameBot'}
            </a>
            <button
              type="button"
              onClick={async () => {
                const ok = await hydratePlayerState();
                if (!ok) {
                  setToast(
                    lang === 'am'
                      ? 'የማረጋገጫ ሁኔታ መፈተሽ አልተቻለም። እንደገና ይሞክሩ።'
                      : 'Could not refresh verification status. Please try again.'
                  );
                }
              }}
              className="w-full px-4 py-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326] text-xs font-extrabold hover:border-[#159447]/40"
            >
              🔄 {lang === 'am' ? 'ማረጋገጫዬን ፈትሽ' : 'Check Verification Status'}
            </button>
          </div>
          <p className="text-[10px] font-mono text-[#68776D]">
            status: phone_verification_required
          </p>
        </div>
      </div>
    );
  }

  const countdownLabel =
    countdown > 0 ? `00:${String(countdown).padStart(2, '0')}` : '00:00';
  const timerPercent =
    activeRoom.status === 'countdown' || activeRoom.status === 'waiting'
      ? Math.max(0, Math.min(100, Math.round((countdown / 60) * 100)))
      : 0;
  const isUrgentCountdown =
    (activeRoom.status === 'countdown' || activeRoom.status === 'waiting') &&
    countdown > 0 &&
    countdown <= 10;

  return (
    <div className="app">
      {/* Centralized Global ADEYBINGO Header */}
      <AppHeader
        lang={lang}
        countdownLabel={
          activeRoom.status === 'live'
            ? 'LIVE'
            : activeRoom.status === 'completed'
              ? countdown > 0
                ? countdownLabel
                : '00:00'
              : countdownLabel
        }
        isLive={activeRoom.status === 'live'}
        isUrgent={isUrgentCountdown}
        demoBalance={demoBalance}
        sound={sound}
        onToggleSound={() => {
          if (sound) soundFX.stopVoice();
          setSound((s) => !s);
        }}
        showBackButton={screen !== 'home'}
        onBack={() => setScreen('home')}
        onBrandClick={() => setScreen('home')}
        onTimerClick={() => void handleEnterLiveGame()}
        onWalletClick={() => setScreen('wallet')}
        onToggleLanguage={() => handleChangeLanguage((l) => (l === 'am' ? 'en' : 'am'))}
        showAdminButton={isVerifiedAdmin}
        isAdminActive={isAdminRoute}
        onAdminClick={() => {
          if (!isVerifiedAdmin) return;
          window.history.pushState({}, '', '/admin');
          setIsAdminRoute(true);
        }}
      />

      {/* Main View Switcher */}
      <main className="mt-1.5 sm:mt-2">
        {screen === 'home' && (
          <div className="space-y-2">
            {/* 1. Compact Hero Dashboard Card: 3D Bingo Balls, Room Status, Timer & Play CTA */}
            <section className="rounded-2xl bg-white border border-[#E7EDE8] p-2 sm:p-3 shadow-[0_3px_12px_rgba(24,51,38,0.05)] space-y-2 relative overflow-hidden">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -top-16 -right-16 w-40 h-40 rounded-full bg-gradient-to-br from-[#E6F6EB] via-[#FEF5DC]/60 to-transparent blur-2xl"
              />

              <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-2">
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1">
                    <GameStatusBadge
                      status={
                        activeRoom.status === 'live'
                          ? 'live'
                          : activeRoom.status === 'completed'
                            ? 'completed'
                            : 'open'
                      }
                      pulse={activeRoom.status === 'live' || activeRoom.status === 'countdown'}
                      label={
                        activeRoom.status === 'live'
                          ? lang === 'am'
                            ? 'ቀጥታ'
                            : 'LIVE'
                          : activeRoom.status === 'completed'
                            ? lang === 'am'
                              ? 'ተጠናቋል'
                              : 'DONE'
                            : lang === 'am'
                              ? activeRoom.nameAm
                              : activeRoom.nameEn
                      }
                    />
                    {rooms.length > 1 && (
                      <div className="flex flex-wrap items-center gap-1 ml-0.5">
                        {rooms.map((rm) => {
                          const isCurrent = rm.id === activeRoom.id;
                          return (
                            <button
                              key={rm.id}
                              type="button"
                              onClick={() => handleSelectRoom(rm.id)}
                              className={`px-1.5 py-0.5 rounded-md text-[9.5px] font-extrabold border transition-colors ${
                                isCurrent
                                  ? 'bg-[#159447] text-white border-[#159447]'
                                  : 'bg-[#FFF9ED] text-[#183326] border-[#E7EDE8] hover:border-[#159447]/40'
                              }`}
                            >
                              {lang === 'am' ? rm.nameAm : rm.nameEn} · {rm.cardPrice} ETB
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Colorful 3D Bingo Balls + Compact Icon Stats */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <div className="flex items-center gap-1">
                      <BingoBall number={7} size="sm" animate={!reducedMotion} />
                      <BingoBall number={22} size="sm" animate={!reducedMotion} />
                      <BingoBall number={38} size="sm" animate={!reducedMotion} />
                      <BingoBall number={54} size="sm" animate={!reducedMotion} />
                      <BingoBall number={71} size="sm" animate={!reducedMotion} />
                    </div>

                    <div className="flex items-center gap-1.5 text-[10.5px] font-extrabold text-[#183326] ml-0.5">
                      <span
                        data-testid="home-confirmed-players"
                        title={lang === 'am' ? 'የተረጋገጡ ተጫዋቾች (ከ600)' : 'Confirmed players (max 600)'}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#FFF9ED] border border-[#E7EDE8]"
                      >
                        <Users size={11} className="text-[#159447]" />
                        {activeRoom.confirmedPlayersCount ?? activeRoom.activePlayers}/600
                      </span>
                      <span
                        data-testid="home-available-spaces"
                        title={lang === 'am' ? 'ክፍት የተጫዋች ቦታዎች' : 'Available player spaces'}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#FFF9ED] border border-[#E7EDE8]"
                      >
                        <Grid size={11} className="text-[#D99B20]" />
                        {activeRoom.availableSpaces ??
                          Math.max(
                            0,
                            600 - (activeRoom.confirmedPlayersCount ?? activeRoom.activePlayers)
                          )}
                      </span>
                      <span
                        data-testid="home-prize-pool"
                        title={lang === 'am' ? 'የዙር አሸናፊ ሽልማት (80%)' : 'Winners prize pool (80%)'}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#FEF5DC] border border-[#F5BD42]/60 text-[#183326]"
                      >
                        <Trophy size={11} className="text-[#D99B20]" />
                        {activeRoom.winnersPrizePoolEtb ?? 0} ETB
                      </span>
                    </div>
                  </div>
                </div>

                {/* Compact Round Timer Card */}
                <div
                  data-testid="home-timer"
                  title={
                    activeRoom.status === 'live'
                      ? lang === 'am'
                        ? 'ቀጥታ ጨዋታ · ካርዶች ተቆልፈዋል'
                        : 'Live round · Cards locked'
                      : lang === 'am'
                        ? 'ከ 00:00 በፊት ካርድ ይምረጡ'
                        : 'Select cards before 00:00'
                  }
                  className={`rounded-xl border px-2.5 py-1.5 sm:px-3 sm:py-2 min-w-[130px] sm:min-w-[150px] shrink-0 space-y-1 ${
                    activeRoom.status === 'live'
                      ? 'bg-[#E6F6EB] border-[#159447]'
                      : activeRoom.status === 'completed'
                        ? 'bg-[#FFF9ED] border-[#F5BD42]'
                        : isUrgentCountdown
                          ? 'bg-[#FEF5DC] border-[#D99B20]'
                          : 'bg-[#FFF9ED] border-[#159447]/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 text-[9.5px] font-extrabold uppercase tracking-wider text-[#08743A]">
                    <span className="flex items-center gap-1">
                      <Clock
                        size={11}
                        className={
                          isCardsLocked
                            ? 'text-[#D94B4B]'
                            : isUrgentCountdown
                              ? 'text-[#D99B20]'
                              : 'text-[#159447]'
                        }
                      />
                      {activeRoom.status === 'live'
                        ? lang === 'am'
                          ? 'ቀጥታ'
                          : 'LIVE'
                        : activeRoom.status === 'completed'
                          ? lang === 'am'
                            ? 'ቀጣይ'
                            : 'NEXT'
                          : lang === 'am'
                            ? 'ሰዓት'
                            : 'TIMER'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className={`font-mono text-base sm:text-lg font-extrabold tabular-nums leading-none ${
                        activeRoom.status === 'live'
                          ? 'text-[#08743A]'
                          : isUrgentCountdown
                            ? 'text-[#D99B20]'
                            : 'text-[#183326]'
                      }`}
                    >
                      {activeRoom.status === 'live'
                        ? `${calls.length}/75`
                        : countdownLabel}
                    </div>
                    <div className="flex-1 max-w-[80px] h-1.5 rounded-full bg-white border border-[#E7EDE8] overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${
                          activeRoom.status === 'live'
                            ? 'bg-[#159447] w-full animate-pulse'
                            : activeRoom.status === 'completed'
                              ? 'bg-[#F5BD42] w-1/3'
                              : isUrgentCountdown
                                ? 'bg-[#D99B20]'
                                : 'bg-gradient-to-r from-[#159447] to-[#F5BD42]'
                        }`}
                        style={
                          activeRoom.status === 'countdown'
                            ? { width: `${timerPercent}%` }
                            : undefined
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Balance & Winnings Strip */}
              <div className="grid grid-cols-2 gap-1.5">
                <BalanceCard
                  variant="emerald"
                  label={lang === 'am' ? 'ቀሪ ሂሳብ' : 'Balance'}
                  amount={demoBalance.toFixed(2)}
                  unit="ETB"
                  tooltip={
                    lang === 'am'
                      ? 'ሲቀላቀሉ 15 ብር የመጀመሪያ ቦነስ ያገኛሉ'
                      : '15 ETB welcome join bonus'
                  }
                  icon={<Wallet className="w-3 h-3" />}
                />

                <BalanceCard
                  variant="gold"
                  label={lang === 'am' ? 'ሽልማት' : 'Winnings'}
                  amount={winningsBalance.toFixed(2)}
                  unit="ETB"
                  tooltip={
                    lang === 'am'
                      ? 'ጓደኛ ሲጋብዙ +20 ብር ቦነስ ያገኛሉ'
                      : 'Earn +20 ETB bonus per invited friend'
                  }
                  icon={<Trophy className="w-3 h-3 text-[#D99B20]" />}
                />
              </div>
            </section>

            {/* 2. Card Number Grid */}
            <section className="rounded-2xl bg-white border border-[#E7EDE8] p-2 sm:p-3 shadow-[0_3px_12px_rgba(24,51,38,0.05)] space-y-2">
              {isCardsLocked && (
                <div className="rounded-lg bg-[#FFF5F5] border border-[#D94B4B]/35 px-2.5 py-1.5 text-[10.5px] font-bold text-[#D94B4B] flex items-center justify-between gap-2">
                  <span>
                    {activeRoom.status === 'completed'
                      ? lang === 'am'
                        ? 'ዙሩ ተጠናቋል · አዲስ ዙር ይጀምራል'
                        : 'Round completed · Next round starting'
                      : lang === 'am'
                        ? 'ቀጥታ ጨዋታ · ካርዶች ተቆልፈዋል'
                        : 'Live round · Cards locked'}
                  </span>
                </div>
              )}

              {/* Warm Cream Container with 8-col mobile / 10-12 desktop Number Tiles */}
              <div className="rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] p-1.5">
                <div className="grid grid-cols-8 sm:grid-cols-10 md:grid-cols-12 gap-1 max-h-[210px] sm:max-h-[260px] overflow-y-auto overscroll-contain pr-0.5">
                  {ALL_CARD_NUMBERS.map((cardNum) => {
                    const isSelected = selectedCardIds.includes(cardNum);
                    const isTaken = activeRoom.takenCardIds.includes(cardNum);
                    const isSpecialGold = cardNum % 25 === 0 || cardNum === 1 || cardNum === 77;
                    return (
                      <BingoNumberTile
                        key={cardNum}
                        cardNumber={cardNum}
                        isSelected={isSelected}
                        isTakenByOther={isTaken}
                        isSpecialGold={isSpecialGold}
                        disabled={isCardsLocked}
                        onSelect={handleToggleCardId}
                        size="sm"
                      />
                    );
                  })}
                </div>
              </div>

              {/* Selected Cards Preview & Confirmation Strip */}
              {selectedCardIds.length > 0 && (
                <div className="space-y-1.5 pt-1.5 border-t border-[#E7EDE8]">
                  <div className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#E6F6EB] border border-[#159447]/30 text-[11px]">
                    <span className="text-[#183326] font-bold">
                      <b className="text-[#08743A] font-mono text-xs">
                        #{selectedCardIds.join(', #')}
                      </b>{' '}
                      <span className="text-[#68776D]">
                        ({(selectedCardIds.length * cardPrice).toFixed(0)} ETB)
                      </span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      {!isCardsLocked && (
                        <button
                          type="button"
                          onClick={handleClearSelectedCards}
                          className="text-[#D94B4B] text-[10.5px] font-extrabold hover:underline"
                        >
                          {lang === 'am' ? 'አጽዳ' : 'Clear'}
                        </button>
                      )}
                      <PrimaryButton
                        size="sm"
                        variant="emerald"
                        onClick={handleEnterLiveGame}
                        icon={<Play size={11} className="fill-current" />}
                      >
                        {lang === 'am' ? 'ይጫወቱ' : 'Play'}
                      </PrimaryButton>
                    </div>
                  </div>

                  {/* Live 5x5 Previews of Selected Cards */}
                  <div
                    className={`grid gap-1.5 ${
                      playerCards.length === 1
                        ? 'grid-cols-1 max-w-[175px]'
                        : 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-4'
                    }`}
                  >
                    {playerCards.map((card) => (
                      <BingoCardView
                        key={card.id}
                        card={card}
                        calledNumbers={calls}
                        markedNumbers={marked}
                        compact
                        onRemoveCard={
                          !isCardsLocked ? (cid) => void handleToggleCardId(cid) : undefined
                        }
                        lang={lang}
                      />
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {(screen === 'lobby' || screen === 'cards') && (
          <LobbyAndCardsScreen
            mode={screen}
            lang={lang}
            rooms={rooms}
            activeRoom={activeRoom}
            onSelectRoom={handleSelectRoom}
            roomPlayers={roomPlayers}
            selectedCardIds={selectedCardIds}
            onToggleCardId={handleToggleCardId}
            onQuickPickCards={handleQuickPickCards}
            onClearSelectedCards={handleClearSelectedCards}
            countdown={countdown}
            cardPrice={cardPrice}
            demoBalance={demoBalance}
            onEnterLiveGame={handleEnterLiveGame}
            onNavigate={setScreen}
          />
        )}

        {screen === 'game' && (
          <LiveGameScreen
            lang={lang}
            activeRoom={activeRoom}
            countdown={countdown}
            cardPrice={cardPrice}
            selectedCardIds={selectedCardIds}
            onToggleCardId={handleToggleCardId}
            playerCards={playerCards}
            calledNumbers={calls}
            markedNumbers={marked}
            autoMark={autoMark}
            onToggleAutoMark={() => setAutoMark((v) => !v)}
            autoCallerActive={autoCallerActive}
            onToggleAutoCaller={() => setAutoCallerActive((v) => !v)}
            callerIntervalSec={callerIntervalSec}
            onChangeCallerInterval={setCallerIntervalSec}
            onResetRound={isVerifiedAdmin ? handleResetRound : undefined}
            onToggleMarkCell={handleToggleCellMark}
            onAddQuickCard={handleAddQuickCard}
            onRemoveCard={(cid) => void handleToggleCardId(cid)}
            onClaimBingo={handleClaimBingo}
            voiceEnabled={voiceEnabled}
            onToggleVoice={() => {
              if (voiceEnabled) soundFX.stopVoice();
              setVoiceEnabled((v) => !v);
            }}
            onSpeakBall={(ballNum) => void soundFX.speakBingoBall(ballNum, lang, true)}
            reducedMotion={reducedMotion}
            onNavigate={setScreen}
          />
        )}

        {(screen === 'wallet' || screen === 'deposit' || screen === 'withdraw') && (
          <WalletScreens
            mode={screen}
            lang={lang}
            demoBalance={demoBalance}
            winningsBalance={winningsBalance}
            transactions={transactions}
            depositRequests={depositRequests}
            payoutRequests={payoutRequests}
            onSubmitDepositRequest={handleSubmitDepositRequest}
            onSubmitWithdrawRequest={handleSubmitWithdrawRequest}
            onNavigate={setScreen}
          />
        )}

        {(screen === 'referral' ||
          screen === 'profile' ||
          screen === 'support' ||
          screen === 'terms') && (
          <CommunityScreens
            mode={screen}
            lang={lang}
            onChangeLang={handleChangeLanguage}
            user={user}
            firebaseUserEmail={fbUser?.email || null}
            firebaseUid={fbUser?.uid || null}
            firestoreConnected={firestoreConnected}
            onSignInGoogle={handleSignInGoogle}
            onSignOutFirebase={handleSignOutFirebase}
            phoneNumber={phoneNumber}
            phoneVerified={phoneVerified}
            onVerifyPhone={handleVerifyPhone}
            serverVerifiedTelegramId={serverVerifiedTelegramId}
            telegramBackendStatus={telegramBackendStatus}
            onValidateTelegramInitData={handleValidateTelegramInitData}
            referralCode={referralCode}
            referredByCode={referredByCode}
            referrals={referrals}
            onApplyPromoCode={handleApplyPromoCode}
            tickets={tickets}
            onSubmitSupportTicket={handleSubmitSupportTicket}
            reducedMotion={reducedMotion}
            onToggleReducedMotion={() => setReducedMotion((r) => !r)}
            onNavigate={setScreen}
          />
        )}
      </main>

      {/* Winner Celebration Modal */}
      <WinnerModal
        open={winnerModalOpen}
        winResult={activeWinResult}
        winningCard={
          winningCardOverride ? generateDeterministicCard(winningCardOverride) : winningCardObj
        }
        calledNumbers={calls}
        markedNumbers={marked}
        prizeDemoEtb={lastVerifiedPrizeEtb}
        winners={roundWinners}
        lang={lang}
        reducedMotion={reducedMotion}
        onPlayAgain={() => {
          setWinnerModalOpen(false);
          setScreen('home');
          void Promise.all([hydrateRoomState(activeRoom.id), hydratePlayerState()]);
        }}
        onClose={() => setWinnerModalOpen(false)}
      />

      {/* Toast Banner */}
      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            initial={{ y: -16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <span>{toast}</span>
            <button type="button" onClick={() => setToast('')} aria-label="Dismiss notification">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Standardized Global Bottom Navigation */}
      <BottomNavigation screen={screen} lang={lang} onNavigate={setScreen} />
    </div>
  );
}
