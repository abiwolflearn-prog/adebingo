import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithCustomToken, User as FirebaseUser } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import {
  Volume2,
  VolumeX,
  Languages,
  Wallet,
  Gift,
  Headphones,
  Home,
  X,
  Trophy,
  User as UserIcon,
  Play,
  Shuffle,
  Search,
  Clock,
} from 'lucide-react';
import {
  DEFAULT_GAME_RULES,
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
import { t } from './utils/i18n';
import { soundFX } from './utils/sound';
import {
  initTelegramMiniApp,
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
    takenCardIds: [],
    countdownSeconds: 60,
    status: 'countdown',
  }));
}

const ALL_CARD_NUMBERS = Array.from({ length: DEFAULT_GAME_RULES.maxCardsPerRoom }, (_, i) => i + 1);

export default function App() {
  const [user] = useState(() => initTelegramMiniApp());
  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(() => checkIsAdminRoute());
  const [homeCardSearch, setHomeCardSearch] = useState<string>('');

  useEffect(() => {
    const onPopState = () => setIsAdminRoute(checkIsAdminRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Default language is Amharic ('am'), with English ('en') switching
  const [lang, setLang] = useState<Language>('am');
  const copy = t(lang);

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
  const activeUidRef = useRef<string>(fbUser?.uid || `tg_${user.id}`);
  activeUidRef.current = fbUser?.uid || `tg_${serverVerifiedTelegramId ?? user.id}`;
  const activeTgIdRef = useRef<number>(serverVerifiedTelegramId ?? user.id);
  activeTgIdRef.current = serverVerifiedTelegramId ?? user.id;

  // Wallet, Referrals, History, Leaderboard, Support, Notifications (verified backend only)
  const [demoBalance, setDemoBalance] = useState<number>(0);
  const [winningsBalance, setWinningsBalance] = useState<number>(0);
  const [referralCode, setReferralCode] = useState<string>(`ADEY-${user.id}`);
  const [referredByCode, setReferredByCode] = useState<string>('');
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
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
            return {
              ...rm,
              cardPrice: Number(match.cardPrice || rm.cardPrice),
              activePlayers: Number(match.activePlayersCount ?? 0),
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

        // Countdown finished -> instantly switch into live game showing selected cards
        if (prevStatus === 'countdown' && nextStatus === 'live') {
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
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === roomIdToLoad
              ? {
                  ...rm,
                  activePlayers: Number(detail.room.activePlayersCount ?? 0),
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
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? {
                  ...rm,
                  activePlayers: players.length,
                }
              : rm
          )
        );
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
      setRooms((prev) =>
        prev.map((rm) =>
          rm.id === activeRoomId ? { ...rm, status: 'live', countdownSeconds: 0 } : rm
        )
      );
      if (screen === 'home' || screen === 'lobby' || screen === 'cards') {
        setScreen('game');
      }
      setAutoCallerActive(true);
      setToast(
        lang === 'am'
          ? '60 ሰከንዱ አልቋል — ጨዋታው በተመረጡ ካርዶችዎ ተጀምሯል!'
          : 'Timer finished — game started with your selected cards!'
      );
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
            ? `ካርድ ${cardId} በሰርቨር ትራንዛክሽን ${
                txRes.action === 'reserved' ? 'ተይዟል' : 'ተለቋል'
              }`
            : `Card ${cardId} ${txRes.action} via server`
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
  }

  // Handler: Quick pick N available cards
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
    const clamped = Math.max(1, Math.min(DEFAULT_GAME_RULES.maxCardsPerPlayer, targetCount));
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
    setToast(
      lang === 'am'
        ? `${picked.length} ካርዶች ተመርጠዋል (${picked.join(', ')})`
        : `Selected ${picked.length} cards (${picked.join(', ')})`
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

  // Handler: Enter Live Game from Lobby/Card Picker (POST /api/game/start when authenticated)
  async function handleEnterLiveGame() {
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
      } catch {
        // Non-fatal: during 60s countdown or watch-only mode, still open the Live Game view
      }
    }
    setScreen('game');
    setToast(lang === 'am' ? `ወደ ${activeRoom.nameAm} ገብተዋል!` : `Joined ${activeRoom.nameEn}!`);
  }

  // Handler: Apply Promo or Referral Code via POST /api/player/wallet
  async function handleApplyPromoCode(code: string): Promise<{ ok: boolean; message: string }> {
    const res = await submitPlayerWalletAction({ action: 'apply_promo', code });
    if (res.ok) {
      soundFX.playWinFanfare(sound);
      await hydratePlayerState();
      const msg =
        lang === 'am'
          ? `ኮዱ ተቀባይነት አግኝቷል (+${Number(res.bonusEtb ?? 0).toFixed(2)} ETB)`
          : `Code applied (+${Number(res.bonusEtb ?? 0).toFixed(2)} ETB)`;
      setToast(msg);
      return { ok: true, message: msg };
    }
    soundFX.playError(sound);
    const errMsg = res.message || (lang === 'am' ? 'ኮዱ አልሰራም' : 'Could not apply promo code');
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
      {/* Compact Top Header */}
      <header className="adey-header">
        <button
          type="button"
          onClick={() => setScreen('home')}
          className="brand text-left bg-transparent border-0 p-0 min-h-[44px]"
        >
          <b className="logo">A</b>
          <strong>
            ADEY<span>BINGO</span>
          </strong>
        </button>

        <div className="actions">
          <button
            type="button"
            onClick={() => setScreen('game')}
            aria-label={lang === 'am' ? 'የዙር ሰዓት ቆጣሪ' : 'Round timer'}
            data-testid="header-timer"
          >
            <Clock
              size={15}
              className={
                isCardsLocked
                  ? 'text-rose-400'
                  : isUrgentCountdown
                    ? 'text-amber-400 animate-pulse'
                    : 'text-[#facc15]'
              }
            />
            <span
              className={`font-mono font-extrabold tabular-nums ${
                isCardsLocked
                  ? 'text-rose-300'
                  : isUrgentCountdown
                    ? 'text-amber-300'
                    : 'text-[#facc15]'
              }`}
            >
              {activeRoom.status === 'countdown'
                ? countdownLabel
                : activeRoom.status === 'live'
                  ? 'LIVE'
                  : '00:05'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setScreen('wallet')}
            aria-label={copy.demoBalanceLabel}
          >
            <Wallet size={15} className="text-cyan-400" />
            <span data-testid="home-demo-balance" className="text-cyan-300 font-extrabold tabular-nums">
              {demoBalance.toFixed(2)} ETB
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleChangeLanguage((l) => (l === 'am' ? 'en' : 'am'))}
            aria-label="Switch language between Amharic and English"
            data-testid="lang-toggle"
          >
            <Languages size={15} />
            {lang === 'am' ? 'አማ' : 'EN'}
          </button>

          <button
            type="button"
            onClick={() => {
              if (sound) soundFX.stopVoice();
              setSound((s) => !s);
            }}
            aria-label={sound ? 'Mute sound' : 'Unmute sound'}
          >
            {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
        </div>
      </header>

      {/* Main View Switcher */}
      <main className="mt-5">
        {screen === 'home' && (
          <div className="space-y-4">
            {/* 1. Primary Play Card */}
            <section className="rounded-3xl bg-[#0f1a2e] border border-slate-700/60 p-5 sm:p-7 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <h1 className="font-['Outfit'] text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                    {lang === 'am' ? 'ቢንጎ ይጫወቱ' : 'Play Live Bingo'}
                  </h1>
                  <p className="text-xs sm:text-sm text-slate-400 max-w-xl">
                    {lang === 'am'
                      ? 'ካርድ ይምረጡ፣ ከዚያ ወዲያውኑ ወደ ቀጥታ ጨዋታው ይግቡ።'
                      : 'Choose your cards, then jump straight into the live game.'}
                  </p>
                </div>

                {/* Prominent Round Timer Display */}
                <div
                  data-testid="home-timer"
                  className={`rounded-2xl border px-4 py-3 min-w-[165px] space-y-2 ${
                    activeRoom.status === 'live'
                      ? 'bg-rose-500/10 border-rose-400/40'
                      : activeRoom.status === 'completed'
                        ? 'bg-amber-500/10 border-amber-400/40'
                        : isUrgentCountdown
                          ? 'bg-amber-500/10 border-amber-400/50'
                          : 'bg-[#091221] border-cyan-400/35'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-bold uppercase tracking-wide">
                    <span className="text-slate-400 flex items-center gap-1">
                      <Clock
                        size={13}
                        className={
                          isCardsLocked
                            ? 'text-rose-400'
                            : isUrgentCountdown
                              ? 'text-amber-400'
                              : 'text-cyan-400'
                        }
                      />
                      {activeRoom.status === 'live'
                        ? lang === 'am'
                          ? 'ቀጥታ ጨዋታ'
                          : 'LIVE ROUND'
                        : activeRoom.status === 'completed'
                          ? lang === 'am'
                            ? 'ቀጣይ ዙር'
                            : 'NEXT ROUND'
                          : lang === 'am'
                            ? 'የካርድ ሰዓት'
                            : 'CARD TIMER'}
                    </span>
                  </div>
                  <div
                    className={`font-mono text-2xl sm:text-3xl font-extrabold tabular-nums leading-none ${
                      activeRoom.status === 'live'
                        ? 'text-rose-300'
                        : activeRoom.status === 'completed'
                          ? 'text-amber-300'
                          : isUrgentCountdown
                            ? 'text-amber-300'
                            : 'text-[#facc15]'
                    }`}
                  >
                    {activeRoom.status === 'countdown'
                      ? countdownLabel
                      : activeRoom.status === 'live'
                        ? `${calls.length}/75`
                        : '00:05'}
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        activeRoom.status === 'live'
                          ? 'bg-rose-400 w-full animate-pulse'
                          : activeRoom.status === 'completed'
                            ? 'bg-amber-400 w-1/3'
                            : isUrgentCountdown
                              ? 'bg-amber-400'
                              : 'bg-gradient-to-r from-[#22d3ee] to-[#facc15]'
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

              {/* Unboxed Metadata Line */}
              <p className="text-xs text-slate-300 tabular-nums">
                {activeRoom.activePlayers} {lang === 'am' ? 'ተጫዋቾች' : 'players'} ·{' '}
                {activeRoom.status === 'live' ? (
                  <b className="text-rose-300">
                    {lang === 'am' ? 'ካርድ ተቆልፏል' : 'Cards Locked'}
                  </b>
                ) : activeRoom.status === 'completed' ? (
                  <b className="text-amber-300">
                    {lang === 'am' ? 'ዙሩ አልቋል · አዲስ ዙር ይጀምራል' : 'Round Over · Next Starting'}
                  </b>
                ) : (
                  <>
                    {lang === 'am' ? 'ቀሪ ጊዜ' : 'Time Left'}{' '}
                    <b className="font-mono text-[#facc15]">{countdownLabel}</b>
                  </>
                )}{' '}
                · {cardPrice} ETB / {lang === 'am' ? 'ካርድ' : 'card'}
              </p>

              {/* Primary Play Action */}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  data-start="true"
                  onClick={handleEnterLiveGame}
                  className="px-6 py-3 rounded-2xl bg-gradient-to-r from-[#facc15] to-[#eab308] text-[#1e1402] font-['Outfit'] text-base font-extrabold flex items-center justify-center gap-2 shadow-sm hover:brightness-105 min-h-[48px] whitespace-nowrap"
                >
                  <Play size={18} />
                  {isCardsLocked
                    ? lang === 'am'
                      ? 'ቀጥታ ጨዋታ ይመልከቱ'
                      : 'Watch Live Game'
                    : selectedCardIds.length > 0
                    ? lang === 'am'
                      ? `በ ${selectedCardIds.length} ካርድ ጨዋታ ጀምር`
                      : `Start Game (${selectedCardIds.length} Card${selectedCardIds.length === 1 ? '' : 's'})`
                    : lang === 'am'
                    ? 'ጨዋታ ጀምር'
                    : 'Start Game'}
                </button>
              </div>
            </section>

            {/* 2. All Cards Selector (1–600) */}
            <section className="rounded-3xl bg-[#0f1a2e] border border-slate-700/60 p-4 sm:p-5 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="font-['Outfit'] text-base font-extrabold text-white">
                    {lang === 'am'
                      ? `ሁሉም ካርዶች (1–600) · ${selectedCardIds.length}/4`
                      : `All Cards (1–600) · ${selectedCardIds.length}/4`}
                  </h2>
                  <p className="text-xs text-slate-400">
                    {isCardsLocked
                      ? lang === 'am'
                        ? '60 ሰከንዱ አልቋል — ይህ ዙር እስኪያልቅ ድረስ ካርድ መምረጥ አይቻልም'
                        : '60s closed — cards are locked until this round ends'
                      : lang === 'am'
                      ? 'የሚፈልጉትን ካርድ ቁጥር ይንኩ (እስከ 4 ካርዶች)'
                      : 'Tap any card number below to choose (up to 4 cards)'}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-36 sm:w-44">
                    <Search
                      size={14}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                    />
                    <input
                      type="search"
                      value={homeCardSearch}
                      onChange={(e) => setHomeCardSearch(e.target.value)}
                      placeholder={lang === 'am' ? 'ካርድ ፈልግ...' : 'Search card...'}
                      aria-label="Search card number 1 to 600"
                      className="w-full pl-8 pr-2.5 py-2 rounded-xl bg-[#091221] border border-slate-700 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
                    />
                  </div>

                  {selectedCardIds.length < 4 && (
                    <button
                      type="button"
                      disabled={isCardsLocked}
                      onClick={() =>
                        selectedCardIds.length === 0
                          ? handleQuickPickCards(1)
                          : handleAddQuickCard()
                      }
                      className="px-3 py-2 rounded-xl bg-cyan-500/15 border border-cyan-400/30 text-cyan-300 text-xs font-extrabold flex items-center gap-1.5 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px] whitespace-nowrap"
                    >
                      <Shuffle size={14} />
                      {selectedCardIds.length === 0
                        ? lang === 'am'
                          ? 'ፈጣን ምርጫ'
                          : 'Quick Pick'
                        : lang === 'am'
                        ? '+ ካርድ ጨምር'
                        : '+ Add Card'}
                    </button>
                  )}
                </div>
              </div>

              {isCardsLocked && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-400/30 px-3 py-2.5 text-xs text-rose-200 flex items-center justify-between gap-2">
                  <span>
                    {activeRoom.status === 'completed'
                      ? lang === 'am'
                        ? 'ዙሩ ተጠናቋል — አዲስ የ60 ሰከንድ ዙር በጥቂት ሰከንዶች ውስጥ ይጀምራል።'
                        : 'Round completed — a fresh 60s card window starts automatically in seconds.'
                      : lang === 'am'
                      ? 'ጨዋታው ቀጥታ እየተካሄደ ነው — ዙሩ እስኪያልቅ ካርዶች ተቆልፈዋል።'
                      : 'Live round in progress — cards are locked until this round finishes.'}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-6 sm:grid-cols-10 md:grid-cols-12 gap-1.5 max-h-[360px] overflow-y-auto p-0.5">
                {(homeCardSearch.trim()
                  ? ALL_CARD_NUMBERS.filter((id) => String(id).includes(homeCardSearch.trim()))
                  : ALL_CARD_NUMBERS
                ).map((cardNum) => {
                  const isSelected = selectedCardIds.includes(cardNum);
                  const isTaken = activeRoom.takenCardIds.includes(cardNum);
                  return (
                    <button
                      key={cardNum}
                      type="button"
                      disabled={isTaken || isCardsLocked}
                      onClick={() => handleToggleCardId(cardNum)}
                      aria-label={`Card ${cardNum}${isSelected ? ' selected' : isTaken ? ' taken' : isCardsLocked ? ' locked' : ''}`}
                      className={`h-10 rounded-lg font-['Outfit'] text-xs font-bold tabular-nums transition-all flex items-center justify-center ${
                        isSelected
                          ? 'bg-[#22d3ee] text-[#041423] ring-2 ring-[#facc15]'
                          : isTaken
                            ? 'bg-slate-800/70 text-slate-600 line-through cursor-not-allowed'
                            : isCardsLocked
                              ? 'bg-[#14223b]/50 text-slate-500 border border-slate-800 cursor-not-allowed opacity-60'
                              : 'bg-[#14223b] text-slate-200 border border-slate-700 hover:border-cyan-400'
                      }`}
                    >
                      {cardNum}
                    </button>
                  );
                })}
              </div>

              {selectedCardIds.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-slate-800/80">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-[#091221] border border-cyan-400/30 text-[11px]">
                    <span className="text-slate-300">
                      {lang === 'am' ? 'የተመረጡ ካርዶች፦' : 'Your Cards:'}{' '}
                      <b className="text-cyan-300 font-mono">
                        {selectedCardIds.join(', ')}
                      </b>
                    </span>
                    {!isCardsLocked && (
                      <button
                        type="button"
                        onClick={() => setSelectedCardIds([])}
                        className="text-rose-400 font-bold hover:underline"
                      >
                        {lang === 'am' ? 'አጽዳ' : 'Clear'}
                      </button>
                    )}
                  </div>

                  {/* Small selected 5x5 cards displayed below the 1–600 grid */}
                  <div
                    className={`grid gap-1.5 ${
                      playerCards.length === 1
                        ? 'grid-cols-1 max-w-[140px]'
                        : 'grid-cols-2 sm:grid-cols-4 max-w-[560px]'
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

            {/* 3. Quiet Utility Links */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-slate-400">
              <button
                type="button"
                onClick={() => setScreen('referral')}
                className="flex items-center gap-1.5 hover:text-cyan-300 bg-transparent border-0 p-1 min-h-[40px]"
              >
                <Gift size={14} className="text-cyan-400" />
                <span>{copy.inviteTitle}</span>
              </button>
              <button
                type="button"
                onClick={() => setScreen('support')}
                className="flex items-center gap-1.5 hover:text-cyan-300 bg-transparent border-0 p-1 min-h-[40px]"
              >
                <Headphones size={14} className="text-cyan-400" />
                <span>{copy.supportTitle}</span>
              </button>
            </div>
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
            onClearSelectedCards={() => setSelectedCardIds([])}
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
            referralCode={referralCode}
            referredByCode={referredByCode}
            transactions={transactions}
            depositRequests={depositRequests}
            payoutRequests={payoutRequests}
            onApplyPromoCode={handleApplyPromoCode}
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
            demoBalance={demoBalance}
            winningsBalance={winningsBalance}
            referralCode={referralCode}
            referrals={referrals}
            leaderboard={leaderboard}
            onApplyPromoCode={handleApplyPromoCode}
            gameHistory={gameHistory}
            tickets={tickets}
            onSubmitSupportTicket={handleSubmitSupportTicket}
            soundEnabled={sound}
            onToggleSound={() => setSound((s) => !s)}
            autoMark={autoMark}
            onToggleAutoMark={() => setAutoMark((a) => !a)}
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

      {/* Compact 4-Tab Player Bottom Navigation Bar */}
      <nav className="bottom-nav" aria-label="Primary Bottom Navigation">
        <button
          type="button"
          className={
            screen === 'home' || screen === 'lobby' || screen === 'cards' || screen === 'game'
              ? 'selected'
              : ''
          }
          onClick={() => setScreen('home')}
        >
          <Home size={16} />
          <span>{copy.navHome}</span>
        </button>
        <button
          type="button"
          className={screen === 'leaderboard' ? 'selected' : ''}
          onClick={() => setScreen('leaderboard')}
        >
          <Trophy size={16} />
          <span>{copy.navRank}</span>
        </button>
        <button
          type="button"
          className={
            screen === 'profile' ||
            screen === 'referral' ||
            screen === 'support' ||
            screen === 'terms'
              ? 'selected'
              : ''
          }
          onClick={() => setScreen('profile')}
        >
          <UserIcon size={16} />
          <span>{copy.navProfile}</span>
        </button>
        <button
          type="button"
          className={
            screen === 'wallet' || screen === 'deposit' || screen === 'withdraw' ? 'selected' : ''
          }
          onClick={() => setScreen('wallet')}
        >
          <Wallet size={16} />
          <span>{copy.navWallet}</span>
        </button>
      </nav>

      <footer className="adey-footer">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <span>© 2026 ADEYBINGO · FIREBASE PROJECT: gen-lang-client-0559010770 · DEMO SANDBOX</span>
          <button
            type="button"
            onClick={() => setScreen('terms')}
            className="underline hover:text-cyan-300 bg-transparent border-0 p-0"
          >
            {lang === 'am' ? 'ህጎች እና ደንቦች' : 'Terms & Rules'}
          </button>
          <button
            type="button"
            onClick={() => setScreen('support')}
            className="underline hover:text-cyan-300 bg-transparent border-0 p-0"
          >
            {lang === 'am' ? 'የተጫዋቾች ድጋፍ' : 'Player Support'}
          </button>
        </div>
      </footer>
    </div>
  );
}
