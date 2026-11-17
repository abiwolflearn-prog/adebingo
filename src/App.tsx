import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithCustomToken, User as FirebaseUser } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import {
  Wallet,
  Gift,
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
  drawNextBall,
  generateDeterministicCard,
  toggleCardSelection,
} from './game/rules';
import {
  evaluateRoundWinners,
  type RoundWinnerShare,
} from './game/roundSettlement';
import { INITIAL_ROOMS, INITIAL_SUPPORT_TICKETS } from './data/demoData';
import {
  DepositRequestSummary,
  GameHistoryItem,
  Language,
  LeaderboardEntry,
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
  initTelegramMiniApp,
  syncTelegramBackButton,
  triggerHaptic,
  waitForTelegramWebAppInitData,
} from './utils/telegram';
import { auth, testFirestoreConnection } from './lib/firebase';
import {
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
  startGameViaServerApi,
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

export default function App() {
  const [user] = useState(() => initTelegramMiniApp());
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
  const [telegramBackendStatus, setTelegramBackendStatus] = useState<string>(
    'Ready to validate Telegram WebApp initData on /api/telegram/auth'
  );

  // Rooms & Lobby state (hydrated from backend — zero fabricated players/countdown)
  const [rooms, setRooms] = useState<RoomConfig[]>(() => buildEmptyInitialRooms());
  const [activeRoomId, setActiveRoomId] = useState<string>(INITIAL_ROOMS[0].id);
  const [roomPlayers, setRoomPlayers] = useState<FirestoreRoomPlayer[]>([]);
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? rooms[0];

  const isCardsLocked = activeRoom.status === 'live' || activeRoom.status === 'completed';

  // Configurable card price from active room
  const [cardPrice, setCardPrice] = useState<number>(DEFAULT_GAME_RULES.defaultCardPrice);
  const [countdown, setCountdown] = useState<number>(60);
  const hasServerRoomSyncRef = useRef<boolean>(false);
  const prevRoomStatusRef = useRef<RoomConfig['status']>('countdown');
  const localWinnerSettledRoundRef = useRef<boolean>(false);
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
  const activeUidRef = useRef<string>(fbUser?.uid || `tg_${user.id}`);
  activeUidRef.current = fbUser?.uid || `tg_${serverVerifiedTelegramId ?? user.id}`;
  const activeTgIdRef = useRef<number>(serverVerifiedTelegramId ?? user.id);
  activeTgIdRef.current = serverVerifiedTelegramId ?? user.id;

  // Every player who joins gets 15 Birr (15 ETB) welcome balance; invited friends grant +20 Birr (20 ETB)
  const [demoBalance, setDemoBalance] = useState<number>(15);
  const [winningsBalance, setWinningsBalance] = useState<number>(0);
  const [referralCode, setReferralCode] = useState<string>(`ADEY-${user.id}`);
  const [referredByCode, setReferredByCode] = useState<string>('');
  const [transactions, setTransactions] = useState<WalletTransaction[]>([
    {
      id: 'tx_welcome_join',
      type: 'referral_bonus',
      amount: 15,
      status: 'demo_completed',
      labelAm: 'የመቀላቀያ እንኳን ደህና መጡ ቦነስ (+15 ብር)',
      labelEn: 'Welcome Join Bonus (+15 ETB)',
      timestamp: 'Just now',
      reference: `WELCOME-${user.id}`,
    },
  ]);
  const [depositRequests, setDepositRequests] = useState<DepositRequestSummary[]>([]);
  const [payoutRequests, setPayoutRequests] = useState<PayoutRequestSummary[]>([]);
  const [referrals, setReferrals] = useState<ReferralRecord[]>([]);
  const [gameHistory, setGameHistory] = useState<GameHistoryItem[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [tickets, setTickets] = useState<SupportTicket[]>(INITIAL_SUPPORT_TICKETS);

  // Audio, Voice, Motion & Toast state
  const [sound, setSound] = useState<boolean>(true);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  const [toast, setToast] = useState<string>('');
  const lastSpokenBallRef = useRef<number | null>(null);

  const playerCards = selectedCardIds.map((id) => generateDeterministicCard(id));

  const hydratePlayerState = useCallback(async () => {
    try {
      const state = await fetchPlayerStateFromApi();
      if (!state || !state.ok) return;
      setDemoBalance(Number(state.wallet.availableBalanceEtb ?? 0));
      setWinningsBalance(Number(state.wallet.winningsBalanceEtb ?? 0));
      setTransactions(Array.isArray(state.transactions) ? state.transactions : []);
      setDepositRequests(Array.isArray(state.depositRequests) ? state.depositRequests : []);
      setPayoutRequests(Array.isArray(state.payoutRequests) ? state.payoutRequests : []);
      setReferrals(Array.isArray(state.referrals) ? state.referrals : []);
      setGameHistory(Array.isArray(state.gameHistory) ? state.gameHistory : []);
      setLeaderboard(Array.isArray(state.leaderboard) ? state.leaderboard : []);
      if (state.profile?.referralCode) {
        setReferralCode(state.profile.referralCode);
      }
      setReferredByCode(state.profile?.referredByCode || '');
      if (typeof state.profile?.phoneVerified === 'boolean') {
        setPhoneVerified(state.profile.phoneVerified);
      }
      if (state.profile?.language === 'am' || state.profile?.language === 'en') {
        setLang(state.profile.language);
      }
    } catch {
      // Non-fatal when unauthenticated
    }
  }, []);

  const hydrateRoomState = useCallback(async (roomIdToLoad: string) => {
    try {
      const token = await getActiveBearerToken();
      const [serverRooms, detail] = await Promise.all([
        fetchRoomsFromServerApi().catch(() => []),
        fetchRoomDetailFromServerApi(roomIdToLoad).catch(() => null),
      ]);

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
      }

      if (detail) {
        hasServerRoomSyncRef.current = true;
        const rawNextStatus: RoomConfig['status'] = detail.room.status || 'countdown';
        const prevStatus = prevRoomStatusRef.current;

        // If local round already announced a winner while server was mid-round, wait until server restarts countdown
        if (localWinnerSettledRoundRef.current && rawNextStatus === 'live') {
          return;
        }
        const nextStatus = rawNextStatus;

        // Countdown finished -> switch into live game ONLY if player has selected at least 1 card
        if (prevStatus === 'countdown' && nextStatus === 'live') {
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

        // New round started -> reset board & unlock 60s card selection
        if (
          (prevStatus === 'live' || prevStatus === 'completed' || localWinnerSettledRoundRef.current) &&
          nextStatus === 'countdown'
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
          setToast(
            langRef.current === 'am'
              ? 'አዲስ የ60 ሰከንድ ዙር ተጀምሯል — ካርድ ይምረጡ!'
              : 'New 60s round started — pick your cards!'
          );
        }
        prevRoomStatusRef.current = nextStatus;

        setCountdown(Number(detail.room.countdownSeconds ?? 0));
        setCardPrice(Number(detail.room.cardPrice || DEFAULT_GAME_RULES.defaultCardPrice));
        if (token) {
          setSelectedCardIds(detail.myCardIds.sort((a, b) => a - b));
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
                  takenCardIds: detail.takenCardIds,
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
          if (Number.isInteger(claimTgId) && claimTgId > 0) {
            setServerVerifiedTelegramId(claimTgId);
          } else {
            const uidMatch = /^tg_([1-9]\d*)$/.exec(currentUser.uid);
            if (uidMatch) {
              setServerVerifiedTelegramId(Number(uidMatch[1]));
            }
          }

          const profile = await ensureUserProfileInFirestore(currentUser, user, lang);
          setPhoneVerified(profile.phoneVerified);
          if (profile.language === 'am' || profile.language === 'en') {
            setLang(profile.language);
          }
          if (typeof profile.demoBalanceEtb === 'number') {
            setDemoBalance(profile.demoBalanceEtb);
          }
          const privContact = await getPrivatePhoneContact(currentUser.uid);
          if (privContact) {
            setPhoneNumber(privContact.phoneNumber);
            setPhoneVerified(privContact.phoneVerified);
          }
          void hydratePlayerState();
          void hydrateRoomState(activeRoomId);
        } catch (err) {
          console.error('Error syncing authenticated user profile:', err);
        }
      } else {
        setServerVerifiedTelegramId(null);
      }
    });

    // Attempt automatic Telegram Mini App initData authentication when launched inside Telegram
    let cancelled = false;
    void (async () => {
      const { initData: rawInitData } = await waitForTelegramWebAppInitData(1500);
      if (cancelled) return;
      if (!rawInitData) {
        setTelegramBackendStatus(
          'No window.Telegram.WebApp.initData detected (open inside @AdeyBingoBot Mini App to authenticate).'
        );
        return;
      }

      try {
        const r = await fetch('/api/telegram/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: rawInitData }),
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
          if (d.sessionToken) setSessionBearerToken(d.sessionToken);
          const profileBalance = d.profile?.demoBalanceEtb ?? d.demoBalanceEtb;
          if (typeof profileBalance === 'number') setDemoBalance(profileBalance);
          const profilePhoneVerified = d.profile?.phoneVerified ?? d.phoneVerified;
          if (typeof profilePhoneVerified === 'boolean') setPhoneVerified(profilePhoneVerified);
          const profileLang = d.profile?.language;
          if (profileLang === 'am' || profileLang === 'en') {
            setLang(profileLang);
          }
          if (d.customToken) {
            await signInWithCustomToken(auth, d.customToken).catch(() => {});
          }
          setTelegramBackendStatus(
            `✓ Authenticated on Server: TG User #${verifiedId || d.telegramUser?.id || ''}`
          );
          await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoomId)]);
        } else {
          const category = d.diagnostics?.failureCategory
            ? ` [${d.diagnostics.failureCategory}]`
            : '';
          const errSummary = `Auth failed (${r.status}): ${d.reason || d.error || 'error'}${category} — ${d.message || 'Verification failed'}`;
          setTelegramBackendStatus(errSummary);
          setToast(d.message || 'Telegram authentication failed');
        }
      } catch (err) {
        if (!cancelled) {
          setTelegramBackendStatus(
            `Auth network error: ${err instanceof Error ? err.message : 'Network failure'}`
          );
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
        const financials = calculateAuthoritativeGameFinancials(confirmedCount, totalSold, 10);
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? {
                  ...rm,
                  activePlayers: financials.confirmedPlayersCount,
                  confirmedPlayersCount: financials.confirmedPlayersCount,
                  verifiedPaidEntriesCount: financials.verifiedPaidEntriesCount,
                  availableSpaces: financials.availableSpaces,
                  totalCardsSold: financials.totalCardsSold,
                  totalCollectedEtb: financials.totalCollectedEtb,
                  adeyShareEtb: financials.adeyShareEtb,
                  winnersPrizePoolEtb: financials.winnersPrizePoolEtb,
                }
              : rm
          )
        );
      },
      (roomDoc) => {
        if (typeof roomDoc.countdownSeconds === 'number') {
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
          Number(roomDoc.cardPrice || 10)
        );
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? {
                  ...rm,
                  status: roomDoc.status || rm.status,
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
      },
      (connState) => {
        setFirestoreConnected(connState === 'online');
      }
    );

    const unsubGame = subscribeToGameState(`game_${activeRoomId}_live`, (liveGame) => {
      if (Array.isArray(liveGame.calledNumbers)) {
        setCalls(liveGame.calledNumbers);
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
  }, [fbUser, activeRoomId, hydrateRoomState]);

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

  // Decrement active room countdown when > 0
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown > 0]);

  // Continuous unstoppable round loop: sync on countdown expiry & drive standalone preview fallback
  useEffect(() => {
    if (hasServerRoomSyncRef.current) {
      if (activeRoom.status === 'countdown' && countdown === 0) {
        void hydrateRoomState(activeRoomId);
      }
      return;
    }

    if (activeRoom.status === 'countdown' && countdown === 0) {
      const confirmedCount = activeRoom.confirmedPlayersCount ?? activeRoom.activePlayers ?? 0;
      const minRequired = activeRoom.minPlayers || DEFAULT_GAME_RULES.minEligiblePlayers;
      if (confirmedCount < minRequired) {
        setCountdown(60);
        if (selectedCardIds.length > 0) {
          setToast(
            lang === 'am'
              ? `ዝቅተኛው የተጫዋች ቁጥር (${minRequired}) ስላልሞላ ምዝገባ ተራዝሟል። ካርድዎ ተጠብቋል።`
              : `Minimum ${minRequired} players not reached (${confirmedCount}/${minRequired}). Registration extended; your cards are preserved.`
          );
        }
        return;
      }

      setRooms((prev) =>
        prev.map((rm) =>
          rm.id === activeRoomId ? { ...rm, status: 'live', countdownSeconds: 0 } : rm
        )
      );
      if (selectedCardIds.length > 0) {
        if (screen === 'home' || screen === 'lobby' || screen === 'cards') {
          setScreen('game');
        }
        setAutoCallerActive(true);
        setToast(
          lang === 'am'
            ? '60 ሰከንዱ አልቋል — ጨዋታው በተመረጡ ካርዶችዎ ተጀምሯል!'
            : 'Timer finished — game started with your selected cards!'
        );
      } else {
        if (screen === 'game') {
          setScreen('home');
        }
        setAutoCallerActive(true);
        setToast(
          lang === 'am'
            ? '60 ሰከንዱ አልቋል — ካርድ ስላልመረጡ በዚህ ዙር መጫወት አይችሉም!'
            : 'Timer ended — you cannot play this round without a selected card!'
        );
      }
      return;
    }

    if (activeRoom.status === 'live' && (calls.length >= 75 || winnerModalOpen)) {
      setAutoCallerActive(false);
      setRooms((prev) =>
        prev.map((rm) => (rm.id === activeRoomId ? { ...rm, status: 'completed' } : rm))
      );
      return;
    }

    if (activeRoom.status === 'completed') {
      const restartTimer = window.setTimeout(() => {
        setAutoCallerActive(false);
        setWinnerModalOpen(false);
        setActiveWinResult(null);
        setLastVerifiedPrizeEtb(0);
        setRoundWinners([]);
        setWinningCardOverride(null);
        setCalls([]);
        setMarked([]);
        setSelectedCardIds([]);
        setCountdown(60);
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? { ...rm, status: 'countdown', countdownSeconds: 60, takenCardIds: [] }
              : rm
          )
        );
        setToast(
          lang === 'am'
            ? 'አዲስ የ60 ሰከንድ ዙር ተጀምሯል — ካርድ ይምረጡ!'
            : 'New 60s round started — pick your cards!'
        );
      }, 6000);
      return () => window.clearTimeout(restartTimer);
    }
  }, [activeRoom.status, activeRoomId, calls.length, countdown, hydrateRoomState, lang, screen, winnerModalOpen]);

  // Automatic client-side diagonal/line win detection fallback for unauthenticated preview play
  useEffect(() => {
    if (
      activeRoom.status !== 'live' ||
      calls.length === 0 ||
      winnerModalOpen ||
      selectedCardIds.length === 0 ||
      serverVerifiedTelegramId !== null ||
      fbUser !== null
    ) {
      return;
    }

    const entries = selectedCardIds.map((cardId) => ({
      cardId,
      uid: `tg_${user.id}`,
      telegramUserId: user.id,
      displayName: `${user.firstName} ${user.lastName || ''}`.trim() || 'Player',
    }));

    const settlement = evaluateRoundWinners({
      entries,
      calledNumbers: calls,
      cardPrice,
      totalCardsInRoom: Math.max(selectedCardIds.length, activeRoom.takenCardIds.length + selectedCardIds.length),
    });

    if (!settlement.hasWinner) return;

    const primary = settlement.winners[0];
    const totalWon = settlement.payoutsByPlayer[0]?.totalPrizeEtb ?? primary.prizeEtb;
    const winCheck = checkCardWin(
      generateDeterministicCard(primary.cardId),
      calls,
      calls,
      true
    );

    localWinnerSettledRoundRef.current = true;
    setAutoCallerActive(false);
    soundFX.stopVoice();
    setRooms((prev) =>
      prev.map((rm) =>
        rm.id === activeRoomId ? { ...rm, status: 'completed', countdownSeconds: 0 } : rm
      )
    );
    setRoundWinners(settlement.winners);
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
    setLastVerifiedPrizeEtb(totalWon);
    setDemoBalance((b) => Number((b + totalWon).toFixed(2)));
    setWinningsBalance((w) => Number((w + totalWon).toFixed(2)));
    setWinnerModalOpen(true);
    soundFX.playWinFanfare(sound);
    triggerHaptic('success');

    if (hasServerRoomSyncRef.current) {
      void verifyWinnerViaServerApi({
        roomId: activeRoomId,
        gameId: `game_${activeRoomId}_live`,
        cardId: primary.cardId,
        markedNumbers: calls,
        calledNumbers: calls,
        claimantTelegramId: user.id,
        playerName: `${user.firstName} ${user.lastName || ''}`.trim() || 'Player',
      }).catch(() => {});
    }
  }, [
    activeRoom.status,
    activeRoom.takenCardIds.length,
    activeRoomId,
    calls,
    cardPrice,
    fbUser,
    selectedCardIds,
    serverVerifiedTelegramId,
    sound,
    user.firstName,
    user.id,
    user.lastName,
    winnerModalOpen,
  ]);

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

  // Auto-Caller interval when enabled in Live Game (only during active live round)
  useEffect(() => {
    if (!autoCallerActive || winnerModalOpen || activeRoom.status !== 'live') return;
    const timer = window.setInterval(() => {
      handleCallNextNumber();
    }, callerIntervalSec * 1000);
    return () => window.clearInterval(timer);
  });

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
    const { initData: rawInitData } = await waitForTelegramWebAppInitData(500);

    try {
      const resp = await fetch('/api/telegram/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: rawInitData }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) {
        const verifiedId = Number(
          data.verifiedTelegramId ?? data.profile?.telegramUserId ?? data.telegramUser?.id
        );
        if (Number.isInteger(verifiedId) && verifiedId > 0) {
          setServerVerifiedTelegramId(verifiedId);
        }
        if (data.sessionToken) {
          setSessionBearerToken(data.sessionToken);
        }
        const profileBalance = data.profile?.demoBalanceEtb ?? data.demoBalanceEtb;
        if (typeof profileBalance === 'number') {
          setDemoBalance(profileBalance);
        }
        const profileLang = data.profile?.language;
        if (profileLang === 'am' || profileLang === 'en') {
          setLang(profileLang);
        }
        if (data.customToken) {
          await signInWithCustomToken(auth, data.customToken);
        }
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
        const category = data.diagnostics?.failureCategory
          ? ` [${data.diagnostics.failureCategory}]`
          : '';
        setTelegramBackendStatus(
          `Server response (${statusCode}): ${data.reason || data.error || 'error'}${category} — ${data.message || 'Verification failed'}`
        );
        setToast(
          lang === 'am'
            ? data.message || 'በቴሌግራም Mini App ውስጥ ይክፈቱ (initData ያስፈልጋል)'
            : data.message || 'Launch inside Telegram Mini App to verify signed initData'
        );
      }
    } catch (err) {
      setToast(
        lang === 'am'
          ? 'የቴሌግራም ማረጋገጫ ስህተት ተፈጥሯል'
          : `Telegram Auth check failed (${err instanceof Error ? err.message : 'error'})`
      );
    }
  }

  // Handler: Firebase Sign-Out
  async function handleSignOutFirebase() {
    await signOutFromFirebase();
    setServerVerifiedTelegramId(null);
    setDemoBalance(0);
    setWinningsBalance(0);
    setTransactions([]);
    setDepositRequests([]);
    setPayoutRequests([]);
    setReferrals([]);
    setGameHistory([]);
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

  // Handler: Save & Verify Phone Number via Server-Authoritative Contact Endpoint
  async function handleVerifyPhone(
    cleanedPhone: string,
    method: 'telegram_contact' | 'sms_otp_demo'
  ) {
    try {
      const resp = await fetch('/api/telegram/bot-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderTelegramId: user.id,
          firstName: user.firstName,
          lastName: user.lastName || '',
          username: user.username.replace(/^@/, ''),
          firebaseUid: fbUser?.uid || `tg_${user.id}`,
          text: '',
          contact:
            method === 'telegram_contact'
              ? {
                  phone_number: cleanedPhone,
                  first_name: user.firstName,
                  user_id: user.id,
                }
              : null,
        }),
      });
      const data = await resp.json();
      if (resp.ok && data.registrationStatus === 'verified') {
        setPhoneNumber(cleanedPhone);
        setPhoneVerified(true);
        setToast(
          lang === 'am'
            ? `ስልክ ቁጥር (${cleanedPhone}) በሰርቨር እና Firestore /private/contact ተረጋግጧል!`
            : `Phone (${cleanedPhone}) verified on server & saved in Firestore /private/contact!`
        );
        return;
      }
    } catch {
      // Fall through
    }

    setPhoneNumber(cleanedPhone);
    setPhoneVerified(true);
    setToast(
      lang === 'am'
        ? `ስልክ ቁጥር (${cleanedPhone}) በሙከራ ሁኔታ ተረጋግጧል`
        : `Phone (${cleanedPhone}) verified in sandbox session`
    );
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
    if (token) {
      try {
        const res = await drawBallViaServerApi({
          roomId: activeRoom.id,
          gameId: `game_${activeRoom.id}_live`,
          callerTelegramId: user.id,
        });
        triggerHaptic('light');
        setCalls(res.calledNumbers);
        return;
      } catch (err) {
        soundFX.playError(sound);
        setToast(err instanceof Error ? err.message : 'Server ball draw failed');
        return;
      }
    }

    // Local preview draw when unauthenticated
    const nextNum = drawNextBall(calls);
    if (nextNum === null) {
      setAutoCallerActive(false);
      setToast(lang === 'am' ? 'ሁሉም 75 ቁጥሮች ተጠርተዋል!' : 'All 75 numbers have been called!');
      return;
    }

    triggerHaptic('light');
    setCalls([...calls, nextNum]);
  }

  // Handler: Toggle card selection (1..600, max 4) via POST /api/cards/reserve when authenticated
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

    const token = await getActiveBearerToken();
    if (token) {
      try {
        const txRes = await toggleCardReservationAtomic({
          roomId: activeRoom.id,
          cardId,
          uid: fbUser?.uid,
          displayName: fbUser?.displayName || `${user.firstName} ${user.lastName || ''}`.trim(),
          telegramUserId: `tg_${user.id}`,
        });
        soundFX.playDaub(sound);
        triggerHaptic('light');
        setSelectedCardIds(txRes.updatedCardIds);
        if (typeof txRes.updatedBalanceEtb === 'number') {
          setDemoBalance(txRes.updatedBalanceEtb);
        }
        setToast(
          lang === 'am'
            ? `ካርድ #${cardId} ${txRes.action === 'reserved' ? 'ተመርጧል (-10 ብር)' : 'ተመልሷል (+10 ብር)'}`
            : `Card #${cardId} ${txRes.action === 'reserved' ? 'selected (-10 ETB)' : 'released (+10 ETB)'}`
        );
        await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoom.id)]);
      } catch (err) {
        soundFX.playError(sound);
        triggerHaptic('error');
        setSelectedCardIds(previousCardIds);
        setToast(err instanceof Error ? err.message : 'Card reservation rejected by server');
      }
      return;
    }

    soundFX.playDaub(sound);
    triggerHaptic('light');
    setSelectedCardIds(result.selectedIds);
    setDemoBalance((b) =>
      isRemoving
        ? Number((b + cardPrice).toFixed(2))
        : Math.max(0, Number((b - cardPrice).toFixed(2)))
    );
  }

  function handleClearSelectedCards() {
    if (isCardsLocked || selectedCardIds.length === 0) return;
    const refund = selectedCardIds.length * cardPrice;
    setSelectedCardIds([]);
    setDemoBalance((b) => Number((b + refund).toFixed(2)));
    setToast(
      lang === 'am'
        ? `የተመረጡ ካርዶች ተሰርዘዋል (+${refund.toFixed(2)} ብር ተመልሷል)`
        : `Cleared selected cards (+${refund.toFixed(2)} ETB refunded)`
    );
  }

  // Handler: Quick pick N available cards (strictly bounded by player's available balance)
  function handleQuickPickCards(targetCount: number) {
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
    const available: number[] = [];
    for (let id = 1; id <= DEFAULT_GAME_RULES.maxCardsPerRoom; id++) {
      if (!activeRoom.takenCardIds.includes(id)) {
        available.push(id);
      }
    }
    const picked: number[] = [];
    while (picked.length < clamped && available.length > 0) {
      const idx = Math.floor(Math.random() * available.length);
      picked.push(available[idx]);
      available.splice(idx, 1);
    }
    soundFX.playDaub(sound);
    setSelectedCardIds(picked.sort((a, b) => a - b));
    setDemoBalance(Math.max(0, Number((totalPoolEtb - picked.length * cardPrice).toFixed(2))));
    setToast(
      lang === 'am'
        ? `${picked.length} ካርድ ተመርጧል (${picked.join(', ')})`
        : `Selected ${picked.length} card${picked.length === 1 ? '' : 's'} (${picked.join(', ')})`
    );
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
            claimantTelegramId: user.id,
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

  // Handler: Reset live round (POST /api/game/reset-round when authenticated)
  async function handleResetRound() {
    localWinnerSettledRoundRef.current = false;
    soundFX.stopVoice();
    const token = await getActiveBearerToken();
    if (token) {
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
    } else {
      setCountdown(60);
      setSelectedCardIds([]);
      setRooms((prev) =>
        prev.map((rm) =>
          rm.id === activeRoom.id
            ? { ...rm, status: 'countdown', countdownSeconds: 60, takenCardIds: [] }
            : rm
        )
      );
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

    const token = await getActiveBearerToken();
    if (token) {
      try {
        const started = await startGameViaServerApi({
          roomId: activeRoom.id,
          gameId: `game_${activeRoom.id}_live`,
        });
        if (Array.isArray(started.calledNumbers)) {
          setCalls(started.calledNumbers);
        }
        await Promise.all([hydratePlayerState(), hydrateRoomState(activeRoom.id)]);
      } catch (err) {
        soundFX.playError(sound);
        setToast(err instanceof Error ? err.message : 'Cannot start game without a reserved card');
        return;
      }
    }
    setScreen('game');
    setToast(lang === 'am' ? `ወደ ${activeRoom.nameAm} ገብተዋል!` : `Joined ${activeRoom.nameEn}!`);
  }

  // Handler: Apply Promo or Referral Code via POST /api/player/wallet (+20 ETB for invited friends)
  async function handleApplyPromoCode(code: string): Promise<{ ok: boolean; message: string }> {
    const cleaned = code.trim().toUpperCase();
    const res = await submitPlayerWalletAction({ action: 'apply_promo', code: cleaned });
    if (res.ok) {
      soundFX.playWinFanfare(sound);
      await hydratePlayerState();
      const bonus = Number(res.bonusEtb ?? 20);
      const msg =
        lang === 'am'
          ? `የግብዣ ኮዱ ተረጋግጧል! (+${bonus.toFixed(2)} ብር ቦነስ)`
          : `Referral code verified! (+${bonus.toFixed(2)} ETB bonus)`;
      setToast(msg);
      return { ok: true, message: msg };
    }

    // Local session fallback when testing without Telegram Bearer token
    const token = await getActiveBearerToken();
    if (!token) {
      if (referredByCode) {
        soundFX.playError(sound);
        const dupMsg =
          lang === 'am'
            ? 'የግብዣ ኮድ ቀደም ብሎ ተጠቅመዋል'
            : 'A referral code has already been applied';
        setToast(dupMsg);
        return { ok: false, message: dupMsg };
      }
      if (cleaned === referralCode.toUpperCase()) {
        soundFX.playError(sound);
        const selfMsg =
          lang === 'am'
            ? 'የራስዎን የግብዣ ኮድ መጠቀም አይችሉም'
            : 'You cannot apply your own referral code';
        setToast(selfMsg);
        return { ok: false, message: selfMsg };
      }
      if (/^ADEY-[A-Z0-9_-]{2,}$/.test(cleaned)) {
        const friendBonus = 20;
        soundFX.playWinFanfare(sound);
        triggerHaptic('success');
        setReferredByCode(cleaned);
        setDemoBalance((b) => Number((b + friendBonus).toFixed(2)));
        setTransactions((prev) => [
          {
            id: `tx_ref_${Date.now()}`,
            type: 'referral_bonus',
            amount: friendBonus,
            status: 'demo_completed',
            labelAm: `የተጋበዘ ጓደኛ ቦነስ (+20 ብር · ${cleaned})`,
            labelEn: `Invited Friend Bonus (+20 ETB · ${cleaned})`,
            timestamp: lang === 'am' ? 'አሁን' : 'Just now',
            reference: `ADB-REF-${Date.now().toString(36).toUpperCase()}`,
          },
          ...prev,
        ]);
        setReferrals((prev) => [
          {
            id: `ref_${Date.now()}`,
            friendName: `Friend (${cleaned})`,
            handle: `@${cleaned.toLowerCase()}`,
            joinedAt: lang === 'am' ? 'አሁን' : 'Just now',
            status: 'qualified',
            inviterBonus: 20,
            inviteeBonus: 20,
          },
          ...prev,
        ]);
        const msg =
          lang === 'am'
            ? `የጓደኛ ግብዣ ቦነስ +20.00 ብር ወደ ሂሳብዎ ተጨምሯል!`
            : `Invited friend bonus +20.00 ETB added to your balance!`;
        setToast(msg);
        return { ok: true, message: msg };
      }
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

  // Handler: Submit Deposit Request via POST /api/player/wallet
  async function handleSubmitDepositRequest(amount: number, provider: string) {
    const res = await submitPlayerWalletAction({
      action: 'deposit_request',
      amountEtb: amount,
      provider,
    });
    if (res.ok) {
      soundFX.playDaub(sound);
      await hydratePlayerState();
      setToast(
        lang === 'am'
          ? `የ ${amount.toFixed(2)} ETB የተቀማጭ ጥያቄ (${provider}) ተልኳል`
          : `Deposit request of ${amount.toFixed(2)} ETB (${provider}) submitted`
      );
      setScreen('wallet');
      return;
    }
    soundFX.playError(sound);
    setToast(res.message || (lang === 'am' ? 'የተቀማጭ ጥያቄ አልተሳካም' : 'Deposit request failed'));
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

  // Handler: Support Ticket
  function handleSubmitSupportTicket(category: string, subject: string, message: string) {
    soundFX.playDaub(sound);
    const newTkt: SupportTicket = {
      id: `TKT-${Math.floor(1000 + Math.random() * 9000)}`,
      category,
      subject,
      message,
      createdAt: lang === 'am' ? 'አሁን' : 'Just now',
      status: 'received',
    };
    setTickets((prev) => [newTkt, ...prev]);
    setToast(
      lang === 'am' ? `የድጋፍ ጥያቄዎ (${newTkt.id}) ተልኳል!` : `Support ticket (${newTkt.id}) submitted!`
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
    void syncLanguagePreference(nextLang, fbUser?.uid, serverVerifiedTelegramId ?? user.id);
  }

  // Automatically attribute invited player referral code (?start=ADEY-... or Telegram start_param)
  // while keeping the player on the exact same unified ADEYBINGO visual theme
  useEffect(() => {
    if (autoAppliedStartRef.current) return;
    const rawStart = (user.startParam || '').trim().toUpperCase();
    if (!rawStart || !/^ADEY-[A-Z0-9_-]{2,}$/.test(rawStart)) return;
    if (rawStart === referralCode.toUpperCase() || referredByCode) return;
    autoAppliedStartRef.current = true;
    void handleApplyPromoCode(rawStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.startParam, referralCode, referredByCode]);

  if (isAdminRoute) {
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

  const countdownLabel =
    countdown > 0 ? `00:${String(countdown).padStart(2, '0')}` : '00:00';
  const timerPercent =
    activeRoom.status === 'countdown'
      ? Math.max(0, Math.min(100, Math.round((countdown / 60) * 100)))
      : 0;
  const isUrgentCountdown =
    activeRoom.status === 'countdown' && countdown > 0 && countdown <= 10;

  return (
    <div className="app">
      {/* Centralized Global ADEYBINGO Header */}
      <AppHeader
        lang={lang}
        countdownLabel={
          activeRoom.status === 'countdown'
            ? countdownLabel
            : activeRoom.status === 'live'
              ? 'LIVE'
              : '00:05'
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
        showAdminButton
        isAdminActive={isAdminRoute}
        onAdminClick={() => {
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
                    {referredByCode && (
                      <span
                        title={lang === 'am' ? 'የጓደኛ ግብዣ ኮድ' : 'Invited friend code'}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#E6F6EB] border border-[#159447]/30 text-[10px] font-extrabold text-[#08743A]"
                      >
                        <Gift size={10} className="text-[#159447]" />
                        {referredByCode}
                      </span>
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
                      {activeRoom.status === 'countdown'
                        ? countdownLabel
                        : activeRoom.status === 'live'
                          ? `${calls.length}/75`
                          : '00:05'}
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
            activeRoom={activeRoom}
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
            onResetRound={handleResetRound}
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

        {(screen === 'leaderboard' ||
          screen === 'referral' ||
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
            referrals={referrals}
            leaderboard={leaderboard}
            onApplyPromoCode={handleApplyPromoCode}
            gameHistory={gameHistory}
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
        onPlayAgain={handleResetRound}
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
