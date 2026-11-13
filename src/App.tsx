import { useEffect, useState } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { motion, AnimatePresence } from 'motion/react';
import {
  Volume2,
  VolumeX,
  Languages,
  Users,
  Wallet,
  Gift,
  Headphones,
  Sparkles,
  Home,
  X,
  Bell,
  Grid,
  Clock,
  FileText,
  Wifi,
  WifiOff,
  RefreshCw,
  LogIn,
  Database,
} from 'lucide-react';
import {
  DEFAULT_GAME_RULES,
  checkCardWin,
  drawNextBall,
  formatBallCall,
  generateDeterministicCard,
  getNextHelpfulNumberForCard,
  toggleCardSelection,
} from './game/rules';
import {
  INITIAL_GAME_HISTORY,
  INITIAL_NOTIFICATIONS,
  INITIAL_REFERRALS,
  INITIAL_ROOMS,
  INITIAL_SUPPORT_TICKETS,
  INITIAL_TRANSACTIONS,
} from './data/demoData';
import {
  ConnectionState,
  GameHistoryItem,
  Language,
  NotificationItem,
  ReferralRecord,
  RoomConfig,
  ScreenId,
  SupportTicket,
  WalletTransaction,
  WinResult,
} from './types/bingo';
import { t } from './utils/i18n';
import { soundFX } from './utils/sound';
import { initTelegramMiniApp, triggerHaptic } from './utils/telegram';
import { auth, testFirestoreConnection } from './lib/firebase';
import {
  ensureDefaultRoomsInFirestore,
  ensureUserProfileInFirestore,
  getPrivatePhoneContact,
  recordDemoReferralInFirestore,
  recordDemoTransactionInFirestore,
  saveVerifiedPhoneNumber,
  signInWithGoogle,
  signOutFromFirebase,
  subscribeToRoomState,
  syncGameSessionInFirestore,
  toggleCardReservationAtomic,
} from './services/firestoreService';
import { BingoBall3D } from './components/BingoBall3D';
import { BingoCardView } from './components/BingoCardView';
import { WinnerModal } from './components/WinnerModal';
import { LobbyAndCardsScreen } from './components/LobbyAndCardsScreen';
import { LiveGameScreen } from './components/LiveGameScreen';
import { WalletScreens } from './components/WalletScreens';
import { CommunityScreens } from './components/CommunityScreens';

export default function App() {
  const [user] = useState(() => initTelegramMiniApp());

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
  const [telegramBackendStatus, setTelegramBackendStatus] = useState<string>(
    'Ready to validate Telegram WebApp initData on /api/telegram/validate-init-data'
  );

  // Rooms & Lobby state
  const [rooms, setRooms] = useState<RoomConfig[]>(INITIAL_ROOMS);
  const [activeRoomId, setActiveRoomId] = useState<string>(INITIAL_ROOMS[0].id);
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? rooms[0];

  // Configurable card price (default 10 ETB)
  const [cardPrice, setCardPrice] = useState<number>(DEFAULT_GAME_RULES.defaultCardPrice);

  // 60-second lobby countdown
  const [countdown, setCountdown] = useState<number>(DEFAULT_GAME_RULES.lobbyCountdownSeconds);

  // Player selected card IDs (1..600, max 4 cards per player)
  const [selectedCardIds, setSelectedCardIds] = useState<number[]>([1]);

  // Live Game state
  const [calls, setCalls] = useState<number[]>([9, 30, 7, 16, 14]);
  const [marked, setMarked] = useState<number[]>([9, 30, 7, 16, 14]);
  const [autoMark, setAutoMark] = useState<boolean>(true);
  const [autoCallerActive, setAutoCallerActive] = useState<boolean>(false);
  const [callerIntervalSec, setCallerIntervalSec] = useState<number>(3);
  const [winnerModalOpen, setWinnerModalOpen] = useState<boolean>(false);
  const [activeWinResult, setActiveWinResult] = useState<WinResult | null>(null);

  // Wallet, Referrals, History, Support, Notifications
  const [demoBalance, setDemoBalance] = useState<number>(250.0);
  const [transactions, setTransactions] = useState<WalletTransaction[]>(INITIAL_TRANSACTIONS);
  const [referrals, setReferrals] = useState<ReferralRecord[]>(INITIAL_REFERRALS);
  const [gameHistory, setGameHistory] = useState<GameHistoryItem[]>(INITIAL_GAME_HISTORY);
  const [tickets, setTickets] = useState<SupportTicket[]>(INITIAL_SUPPORT_TICKETS);
  const [notifications, setNotifications] = useState<NotificationItem[]>(INITIAL_NOTIFICATIONS);
  const [notificationsOpen, setNotificationsOpen] = useState<boolean>(false);

  // Audio, Motion & Connection resilience state
  const [sound, setSound] = useState<boolean>(true);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('online');
  const [toast, setToast] = useState<string>(
    'እንኳን ወደ ADEYBINGO በደህና መጡ! · Welcome to ADEYBINGO'
  );

  const effectiveCardIds = selectedCardIds.length > 0 ? selectedCardIds : [1];
  const playerCards = effectiveCardIds.map((id) => generateDeterministicCard(id));
  const latestBall = calls[calls.length - 1] ?? 9;

  // 1. Verify Firestore connection & listen to Firebase Auth state
  useEffect(() => {
    testFirestoreConnection().then((ok) => setFirestoreConnected(ok));

    const unsubAuth = onAuthStateChanged(auth, async (currentUser) => {
      setFbUser(currentUser);
      if (currentUser) {
        try {
          await ensureDefaultRoomsInFirestore();
          const profile = await ensureUserProfileInFirestore(currentUser, user, lang);
          setPhoneVerified(profile.phoneVerified);
          const privContact = await getPrivatePhoneContact(currentUser.uid);
          if (privContact) {
            setPhoneNumber(privContact.phoneNumber);
            setPhoneVerified(privContact.phoneVerified);
          }
        } catch (err) {
          console.error('Error syncing authenticated user profile:', err);
        }
      }
    });

    return () => unsubAuth();
  }, []);

  // 2. Real-time Room & Card Reservation listener when authenticated
  useEffect(() => {
    if (!fbUser) return;
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
        if (myCards.length > 0) {
          setSelectedCardIds(myCards.sort((a, b) => a - b));
        }
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? {
                  ...rm,
                  takenCardIds: Array.from(
                    new Set([...INITIAL_ROOMS.find((x) => x.id === rm.id)!.takenCardIds, ...otherTakenCards])
                  ),
                }
              : rm
          )
        );
      },
      (players) => {
        setRooms((prev) =>
          prev.map((rm) =>
            rm.id === activeRoomId
              ? {
                  ...rm,
                  activePlayers: Math.max(
                    INITIAL_ROOMS.find((x) => x.id === rm.id)!.activePlayers,
                    35 + players.length
                  ),
                }
              : rm
          )
        );
      }
    );

    return () => unsubRoom();
  }, [fbUser, activeRoomId]);

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

  // 60-second Lobby countdown timer
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? DEFAULT_GAME_RULES.lobbyCountdownSeconds : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Auto-dismiss toast notifications after 3.2 seconds
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Auto-Caller interval when enabled in Live Game
  useEffect(() => {
    if (!autoCallerActive || winnerModalOpen) return;
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

  // Handler: Firebase Google Sign-In
  async function handleSignInGoogle() {
    try {
      const signedInUser = await signInWithGoogle();
      setToast(
        lang === 'am'
          ? `በFirebase ተገናኝተዋል (${signedInUser.email})`
          : `Signed in to Firebase (${signedInUser.email})`
      );
    } catch (err) {
      setToast(
        lang === 'am'
          ? 'የGoogle መግቢያ ሳጥን ተዘግቷል · በሙከራ ሁኔታ መቀጠል ይችላሉ'
          : `Google Sign-In popup closed (${err instanceof Error ? err.message : 'cancelled'})`
      );
    }
  }

  // Handler: Firebase Sign-Out
  async function handleSignOutFirebase() {
    await signOutFromFirebase();
    setToast(lang === 'am' ? 'ከFirebase ወጥተዋል' : 'Signed out from Firebase');
  }

  // Handler: Validate Telegram Mini App initData on trusted backend (/api/telegram/validate-init-data)
  async function handleValidateTelegramInitData() {
    const rawInitData =
      (
        window as unknown as {
          Telegram?: { WebApp?: { initData?: string } };
        }
      ).Telegram?.WebApp?.initData || '';

    try {
      const resp = await fetch('/api/telegram/validate-init-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: rawInitData, envelope: true }),
      });
      const data = await resp.json();
      if (resp.ok && data.verified) {
        setTelegramBackendStatus(
          `✓ Verified on Server: TG User #${data.telegramUser?.id} (hash ${String(
            data.dataCheckHash
          ).slice(0, 12)}...)`
        );
        setToast(
          lang === 'am'
            ? 'የቴሌግራም initData በሰርቨር ተረጋግጧል!'
            : 'Telegram initData cryptographically verified on server!'
        );
      } else {
        const statusCode = data.statusCode || resp.status;
        setTelegramBackendStatus(`Server response (${statusCode}): ${data.message || data.reason}`);
        setToast(data.message || 'Telegram initData check completed');
      }
    } catch (err) {
      setTelegramBackendStatus(
        `Backend error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Handler: Save & Verify Phone Number in PII-isolated subcollection (/users/{uid}/private/contact)
  async function handleVerifyPhone(
    cleanedPhone: string,
    method: 'telegram_contact' | 'sms_otp_demo'
  ) {
    if (fbUser) {
      const saved = await saveVerifiedPhoneNumber(fbUser.uid, cleanedPhone, method);
      setPhoneNumber(saved.phoneNumber);
      setPhoneVerified(saved.phoneVerified);
      setToast(
        lang === 'am'
          ? `ስልክ ቁጥር (${saved.phoneNumber}) በFirestore /private/contact ተረጋግጧል!`
          : `Phone (${saved.phoneNumber}) verified & saved in Firestore /private/contact!`
      );
    } else {
      setPhoneNumber(cleanedPhone);
      setPhoneVerified(true);
      setToast(
        lang === 'am'
          ? `ስልክ ቁጥር (${cleanedPhone}) በሙከራ ሁኔታ ተረጋግጧል (ለCloud ጥበቃ በGoogle ይግቡ)`
          : `Phone (${cleanedPhone}) verified in session (Sign in with Google to persist in Firestore)`
      );
    }
  }

  // Handler: Server-Authoritative Call Next Ball (/api/game/draw-ball + Firestore sync)
  async function handleCallNextNumber() {
    let nextNum: number | null = null;
    try {
      const resp = await fetch('/api/game/draw-ball', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calledNumbers: calls }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (typeof data.ball === 'number') {
          nextNum = data.ball;
        }
      }
    } catch {
      // Fallback to local draw if offline
    }

    if (nextNum === null) {
      nextNum = drawNextBall(calls);
    }

    if (nextNum === null) {
      setAutoCallerActive(false);
      setToast(
        lang === 'am'
          ? 'ሁሉም 75 ቁጥሮች ተጠርተዋል!'
          : 'All 75 numbers have been called!'
      );
      return;
    }

    soundFX.playBallCall(sound);
    triggerHaptic('light');
    const updatedCalls = [...calls, nextNum];
    setCalls(updatedCalls);

    if (fbUser) {
      syncGameSessionInFirestore({
        gameId: `game_${activeRoom.id}_live`,
        roomId: activeRoom.id,
        hostUid: fbUser.uid,
        status: 'live',
        calledNumbers: updatedCalls,
        latestBall: nextNum,
      }).catch(() => {});
    }
  }

  // Handler: Draw Helpful Ball for fast demo testing
  function handleCallHelpfulNumber() {
    const firstCard = playerCards[0];
    const helpful = getNextHelpfulNumberForCard(firstCard, calls);
    if (helpful === null) {
      handleCallNextNumber();
      return;
    }
    soundFX.playBallCall(sound);
    triggerHaptic('medium');
    const updatedCalls = calls.includes(helpful) ? calls : [...calls, helpful];
    setCalls(updatedCalls);
    setToast(
      lang === 'am'
        ? `የተጠራ ቁጥር፦ ${formatBallCall(helpful)}`
        : `Called ${formatBallCall(helpful)}!`
    );

    if (fbUser) {
      syncGameSessionInFirestore({
        gameId: `game_${activeRoom.id}_live`,
        roomId: activeRoom.id,
        hostUid: fbUser.uid,
        status: 'live',
        calledNumbers: updatedCalls,
        latestBall: helpful,
      }).catch(() => {});
    }
  }

  // Handler: Toggle card selection (1..600, max 4) with Atomic Firestore Transaction when signed in
  async function handleToggleCardId(cardId: number) {
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
          lang === 'am'
            ? 'በአንድ ተጫዋች ቢበዛ 4 ካርዶች ብቻ ይፈቀዳሉ'
            : 'Maximum 4 cards per player'
        );
      } else if (result.reason === 'taken_by_other') {
        setToast(
          lang === 'am'
            ? `ካርድ #${cardId} በሌላ ተጫዋች ተይዟል`
            : `Card #${cardId} is already taken`
        );
      }
      return;
    }

    soundFX.playDaub(sound);
    triggerHaptic('light');
    setSelectedCardIds(result.selectedIds);

    if (fbUser) {
      try {
        const txRes = await toggleCardReservationAtomic({
          roomId: activeRoom.id,
          cardId,
          uid: fbUser.uid,
          displayName: fbUser.displayName || `${user.firstName} ${user.lastName || ''}`.trim(),
          telegramUserId: `tg_${user.id}`,
        });
        setSelectedCardIds(txRes.updatedCardIds);
        setToast(
          lang === 'am'
            ? `ካርድ #${cardId} በFirestore አቶሚክ ትራንዛክሽን ${
                txRes.action === 'reserved' ? 'ተይዟል' : 'ተለቋል'
              }`
            : `Card #${cardId} atomically ${txRes.action} in Firestore`
        );
      } catch (err) {
        setToast(err instanceof Error ? err.message : 'Card reservation error');
      }
    }
  }

  // Handler: Quick pick N available cards
  function handleQuickPickCards(targetCount: number) {
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
        ? `${picked.length} ካርዶች ተመርጠዋል (${picked.map((n) => `#${n}`).join(', ')})`
        : `Selected ${picked.length} cards (${picked.map((n) => `#${n}`).join(', ')})`
    );
  }

  // Handler: Add 1 card quickly (up to 4)
  function handleAddQuickCard() {
    if (selectedCardIds.length >= DEFAULT_GAME_RULES.maxCardsPerPlayer) {
      soundFX.playError(sound);
      setToast(
        lang === 'am'
          ? 'በአንድ ተጫዋች ቢበዛ 4 ካርዶች ብቻ ይፈቀዳሉ'
          : 'Maximum 4 cards per player'
      );
      return;
    }
    for (let id = 1; id <= DEFAULT_GAME_RULES.maxCardsPerRoom; id++) {
      if (!selectedCardIds.includes(id) && !activeRoom.takenCardIds.includes(id)) {
        handleToggleCardId(id);
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
    setMarked((prev) =>
      prev.includes(num) ? prev.filter((x) => x !== num) : [...prev, num]
    );
  }

  // Handler: Verify BINGO claim across all player cards (with server verification + Firestore sync)
  async function handleClaimBingo() {
    for (const card of playerCards) {
      const winCheck = checkCardWin(card, marked, calls, true);
      if (winCheck.won) {
        // Also verify on trusted backend /api/game/verify-winner
        try {
          await fetch('/api/game/verify-winner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cardId: card.id,
              calledNumbers: calls,
              markedNumbers: marked,
            }),
          });
        } catch {
          // Continue if offline
        }

        soundFX.playWinFanfare(sound);
        triggerHaptic('success');
        setAutoCallerActive(false);
        setActiveWinResult(winCheck);
        setWinnerModalOpen(true);

        const prizeCredit = Math.max(50, selectedCardIds.length * cardPrice * 4);
        const refCode = `ADB-WIN-${Math.floor(10000 + Math.random() * 89999)}`;
        setDemoBalance((prev) => prev + prizeCredit);
        setTransactions((prev) => [
          {
            id: `tx-${Date.now()}`,
            type: 'bingo_win',
            amount: prizeCredit,
            provider: activeRoom.nameEn,
            status: 'demo_completed',
            labelAm: `የቢንጎ አሸናፊነት ሽልማት (ካርድ #${card.id} · Demo)`,
            labelEn: `Bingo Win Credit (Card #${card.id} · Demo)`,
            timestamp: lang === 'am' ? 'አሁን' : 'Just now',
            reference: refCode,
          },
          ...prev,
        ]);
        setGameHistory((prev) => [
          {
            id: `gh-${Date.now()}`,
            roomNameAm: activeRoom.nameAm,
            roomNameEn: activeRoom.nameEn,
            playedAt: lang === 'am' ? 'አሁን' : 'Just now',
            cardIds: [...effectiveCardIds],
            entryFeeDemo: effectiveCardIds.length * cardPrice,
            outcome: 'won',
            prizeDemo: prizeCredit,
            winningBall: formatBallCall(latestBall),
            callsCount: calls.length,
            patternAm: winCheck.patternLabelAm,
            patternEn: winCheck.patternLabelEn,
          },
          ...prev,
        ]);

        if (fbUser) {
          syncGameSessionInFirestore({
            gameId: `game_${activeRoom.id}_live`,
            roomId: activeRoom.id,
            hostUid: fbUser.uid,
            status: 'completed',
            calledNumbers: calls,
            latestBall,
            winnerUid: fbUser.uid,
            winnerName: fbUser.displayName || user.firstName,
            winningCardId: card.id,
            winningPattern: winCheck.patternLabelEn || 'Bingo Line',
          }).catch(() => {});

          recordDemoTransactionInFirestore({
            uid: fbUser.uid,
            type: 'bingo_win',
            amountEtb: prizeCredit,
            status: 'demo_completed',
            description: `Bingo Win Credit (Card #${card.id})`,
            reference: refCode,
          }).catch(() => {});
        }

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

  // Handler: Reset live round
  function handleResetRound() {
    setAutoCallerActive(false);
    setWinnerModalOpen(false);
    setActiveWinResult(null);
    setCalls([9, 30, 7, 16, 14]);
    setMarked(autoMark ? [9, 30, 7, 16, 14] : []);
    setToast(lang === 'am' ? 'የሙከራ ዙሩ እንደገና ተጀምሯል' : 'Demo round reset');
  }

  // Handler: Enter Live Game from Lobby/Card Picker
  function handleEnterLiveGame() {
    if (selectedCardIds.length === 0) {
      setSelectedCardIds([1]);
    }
    const cost = Math.max(1, selectedCardIds.length) * cardPrice;
    const refCode = `ADB-ENT-${Math.floor(10000 + Math.random() * 89999)}`;
    if (demoBalance >= cost) {
      setDemoBalance((prev) => prev - cost);
      setTransactions((prev) => [
        {
          id: `tx-${Date.now()}`,
          type: 'card_entry',
          amount: -cost,
          provider: activeRoom.nameEn,
          status: 'demo_completed',
          labelAm: `${Math.max(1, selectedCardIds.length)} የቢንጎ ካርድ መግቢያ (Demo)`,
          labelEn: `${Math.max(1, selectedCardIds.length)} Bingo Card Entry (Demo)`,
          timestamp: lang === 'am' ? 'አሁን' : 'Just now',
          reference: refCode,
        },
        ...prev,
      ]);

      if (fbUser) {
        recordDemoTransactionInFirestore({
          uid: fbUser.uid,
          type: 'card_entry',
          amountEtb: -cost,
          status: 'demo_completed',
          description: `${Math.max(1, selectedCardIds.length)} Bingo Card Entry`,
          reference: refCode,
        }).catch(() => {});
      }
    }
    setScreen('game');
    setToast(
      lang === 'am'
        ? `ወደ ${activeRoom.nameAm} ገብተዋል!`
        : `Joined ${activeRoom.nameEn}!`
    );
  }

  // Handler: Demo Deposit
  function handleSimulateDeposit(amount: number, provider: string) {
    soundFX.playDaub(sound);
    const refCode = `ADB-DEP-${Math.floor(10000 + Math.random() * 89999)}`;
    setDemoBalance((prev) => prev + amount);
    setTransactions((prev) => [
      {
        id: `tx-${Date.now()}`,
        type: 'deposit_demo',
        amount,
        provider,
        status: 'demo_completed',
        labelAm: `የሙከራ ሂሳብ መሙያ (${provider})`,
        labelEn: `Demo Sandbox Deposit (${provider})`,
        timestamp: lang === 'am' ? 'አሁን' : 'Just now',
        reference: refCode,
      },
      ...prev,
    ]);

    if (fbUser) {
      recordDemoTransactionInFirestore({
        uid: fbUser.uid,
        type: 'deposit_demo',
        amountEtb: amount,
        status: 'demo_completed',
        description: `Demo Sandbox Deposit (${provider})`,
        reference: refCode,
      }).catch(() => {});
    }

    setToast(
      lang === 'am'
        ? `+${amount.toFixed(2)} ETB ወደ ሙከራ ቦርሳዎ ተጨምሯል`
        : `+${amount.toFixed(2)} ETB added to your Demo Wallet`
    );
    setScreen('wallet');
  }

  // Handler: Demo Withdraw
  function handleSimulateWithdraw(
    amount: number,
    provider: string,
    accountPhone: string
  ): boolean {
    if (amount > demoBalance) return false;
    soundFX.playDaub(sound);
    const refCode = `ADB-WDR-${Math.floor(10000 + Math.random() * 89999)}`;
    setDemoBalance((prev) => prev - amount);
    setTransactions((prev) => [
      {
        id: `tx-${Date.now()}`,
        type: 'withdraw_demo',
        amount: -amount,
        provider,
        status: 'demo_pending',
        labelAm: `የሙከራ ወጪ ጥያቄ ወደ ${accountPhone} (${provider})`,
        labelEn: `Demo Withdrawal Request to ${accountPhone} (${provider})`,
        timestamp: lang === 'am' ? 'አሁን' : 'Just now',
        reference: refCode,
      },
      ...prev,
    ]);

    if (fbUser) {
      recordDemoTransactionInFirestore({
        uid: fbUser.uid,
        type: 'withdraw_demo',
        amountEtb: -amount,
        status: 'demo_pending',
        description: `Demo Withdrawal Request to ${accountPhone}`,
        reference: refCode,
      }).catch(() => {});
    }

    setToast(
      lang === 'am'
        ? `የ ${amount.toFixed(2)} ETB የሙከራ ወጪ ጥያቄ ተመዝግቧል`
        : `Demo withdrawal of ${amount.toFixed(2)} ETB recorded`
    );
    setScreen('wallet');
    return true;
  }

  // Handler: Simulate Friend Referral
  function handleSimulateFriendJoin(friendName: string) {
    soundFX.playWinFanfare(sound);
    const handle = `@${friendName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'friend'}_et`;
    const refCode = `ADB-REF-${Math.floor(10000 + Math.random() * 89999)}`;
    const newRef: ReferralRecord = {
      id: `ref-${Date.now()}`,
      friendName,
      handle,
      joinedAt: lang === 'am' ? 'አሁን · Just now' : 'Just now',
      status: 'qualified',
      inviterBonus: DEFAULT_GAME_RULES.inviterBonusEtb,
      inviteeBonus: DEFAULT_GAME_RULES.inviteeBonusEtb,
    };
    setReferrals((prev) => [newRef, ...prev]);
    setDemoBalance((prev) => prev + DEFAULT_GAME_RULES.inviterBonusEtb);
    setTransactions((prev) => [
      {
        id: `tx-${Date.now()}`,
        type: 'referral_bonus',
        amount: DEFAULT_GAME_RULES.inviterBonusEtb,
        provider: 'ADEY Referral',
        status: 'demo_completed',
        labelAm: `የጓደኛ ግብዣ ቦነስ (${friendName})`,
        labelEn: `Referral Bonus (${friendName})`,
        timestamp: lang === 'am' ? 'አሁን' : 'Just now',
        reference: refCode,
      },
      ...prev,
    ]);

    if (fbUser) {
      recordDemoReferralInFirestore({
        inviterUid: fbUser.uid,
        friendName,
        friendHandle: handle,
      }).catch(() => {});

      recordDemoTransactionInFirestore({
        uid: fbUser.uid,
        type: 'referral_bonus',
        amountEtb: DEFAULT_GAME_RULES.inviterBonusEtb,
        status: 'demo_completed',
        description: `Referral Bonus (${friendName})`,
        reference: refCode,
      }).catch(() => {});
    }

    setToast(
      lang === 'am'
        ? `${friendName} ተቀላቅሏል! +20 ETB የሙከራ ቦነስ አግኝተዋል`
        : `${friendName} joined! +20 ETB demo referral bonus credited`
    );
  }

  // Handler: Support Ticket
  function handleSubmitSupportTicket(
    category: string,
    subject: string,
    message: string
  ) {
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
      lang === 'am'
        ? `የድጋፍ ጥያቄዎ (${newTkt.id}) ተልኳል!`
        : `Support ticket (${newTkt.id}) submitted!`
    );
  }

  const unreadCount = notifications.filter((n) => !n.read).length;
  const winningCardObj =
    playerCards.find((c) => c.id === activeWinResult?.cardId) ?? playerCards[0];

  return (
    <div className="app">
      {/* Top Header */}
      <header className="adey-header">
        <button
          type="button"
          onClick={() => setScreen('home')}
          className="brand text-left bg-transparent border-0 p-0"
        >
          <b className="logo">A</b>
          <div>
            <strong>
              ADEY<span>BINGO</span>
            </strong>
            <small>{copy.brandSubtitle}</small>
          </div>
        </button>

        {/* Desktop Quick Screen Links */}
        <div className="hidden lg:flex items-center gap-1 bg-white border border-[#e3ece5] p-1 rounded-2xl">
          {(
            [
              { id: 'home', label: copy.navHome },
              { id: 'lobby', label: copy.navLobby },
              { id: 'cards', label: `${copy.navCards} (1–600)` },
              { id: 'game', label: copy.navGame },
              { id: 'wallet', label: copy.navWallet },
              { id: 'referral', label: copy.navFriends },
              { id: 'support', label: copy.navSupport },
              { id: 'terms', label: copy.navTerms },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setScreen(item.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-extrabold transition-colors whitespace-nowrap ${
                screen === item.id ||
                (item.id === 'wallet' && (screen === 'deposit' || screen === 'withdraw'))
                  ? 'bg-[#087e50] text-white'
                  : 'text-[#486655] hover:bg-[#f0f8f2]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="actions">
          {/* Firebase Cloud Status & Quick Sign-In Button (Desktop/Tablet) */}
          {!fbUser ? (
            <button
              type="button"
              onClick={handleSignInGoogle}
              aria-label="Sign in with Google to sync with Firebase"
              title="Sign in with Google to enable real-time Firestore card reservations"
              className="!hidden sm:!flex"
            >
              <LogIn size={15} className="text-[#087e50]" />
              <span>{lang === 'am' ? 'ግባ (Cloud)' : 'Sign In'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setScreen('profile')}
              aria-label="Firebase Cloud Sync Active"
              title={`Connected to Firestore as ${fbUser.email}`}
              className="!hidden sm:!flex"
            >
              <Database size={15} className="text-[#087e50]" />
              <span className="text-[#087e50]">Cloud</span>
            </button>
          )}

          {/* Connection State Simulator Button (Desktop/Tablet) */}
          <button
            type="button"
            onClick={() => {
              const order: ConnectionState[] = ['online', 'reconnecting', 'offline'];
              const nextState =
                order[(order.indexOf(connectionState) + 1) % order.length];
              setConnectionState(nextState);
            }}
            aria-label={`Connection status ${connectionState}`}
            title="Click to test Online / Reconnecting / Offline banners"
            className="!hidden sm:!flex"
          >
            {connectionState === 'online' && <Wifi size={16} className="text-[#087e50]" />}
            {connectionState === 'reconnecting' && (
              <RefreshCw size={16} className="text-[#d49a19] animate-spin" />
            )}
            {connectionState === 'offline' && <WifiOff size={16} className="text-red-600" />}
          </button>

          {/* Sound Toggle */}
          <button
            type="button"
            onClick={() => setSound((s) => !s)}
            aria-label={sound ? 'Mute sound' : 'Unmute sound'}
          >
            {sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
            <span className="hidden sm:inline">{sound ? 'ON' : 'OFF'}</span>
          </button>

          {/* Language Switcher */}
          <button
            type="button"
            onClick={() => setLang((l) => (l === 'am' ? 'en' : 'am'))}
            aria-label="Switch language between Amharic and English"
            data-testid="lang-toggle"
          >
            <Languages size={16} />
            {lang === 'am' ? 'አማ' : 'EN'}
          </button>

          {/* Notifications Button */}
          <button
            type="button"
            onClick={() => {
              setNotificationsOpen((o) => !o);
              setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
            }}
            aria-label="Notifications"
            className="relative"
          >
            <Bell size={16} />
            {unreadCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-[#eab308] text-[#451a03] text-[10px] font-extrabold flex items-center justify-center">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Profile Avatar */}
          <button
            type="button"
            onClick={() => setScreen('profile')}
            aria-label="Open player profile"
            className="avatar"
          >
            {user.initials}
          </button>
        </div>
      </header>

      {/* Connection Status Banner when Reconnecting or Offline */}
      {connectionState !== 'online' && (
        <div
          role="status"
          className={`mt-3 p-3 rounded-2xl text-xs font-extrabold flex items-center justify-between ${
            connectionState === 'reconnecting'
              ? 'bg-[#fef6d8] border border-[#f2d06b] text-[#6e4f07]'
              : 'bg-[#fee2e2] border border-[#fca5a5] text-[#991b1b]'
          }`}
        >
          <span>
            {connectionState === 'reconnecting'
              ? lang === 'am'
                ? '⟳ ከጨዋታ ክፍሉ ጋር እንደገና በመገናኘት ላይ (Reconnecting...)'
                : '⟳ Reconnecting to live game server...'
              : lang === 'am'
              ? '⚠ የኢንተርኔት ግንኙነት ተቋርጧል (Offline Mode) — ካርዶችዎ ተጠብቀዋል።'
              : '⚠ You are currently offline — your selected cards are preserved.'}
          </span>
          <button
            type="button"
            onClick={() => setConnectionState('online')}
            className="px-3 py-1 rounded-lg bg-white text-[#193b2b] text-xs font-extrabold"
          >
            {lang === 'am' ? 'አሁን አገናኝ' : 'Reconnect Now'}
          </button>
        </div>
      )}

      {/* Collapsible Notifications Drawer */}
      <AnimatePresence>
        {notificationsOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mt-3 bg-white border border-[#dce8df] rounded-2xl p-4 shadow-lg space-y-2.5"
          >
            <div className="flex items-center justify-between">
              <b className="font-['Outfit'] text-sm font-extrabold text-[#193b2b]">
                {lang === 'am' ? 'ማሳወቂያዎች (Notifications)' : 'Notifications'}
              </b>
              <button
                type="button"
                onClick={() => setNotificationsOpen(false)}
                className="text-xs font-bold text-[#647b6d]"
              >
                {lang === 'am' ? 'ዝጋ ✕' : 'Close ✕'}
              </button>
            </div>
            <div className="divide-y divide-[#edf4ef]">
              {notifications.map((n) => (
                <div key={n.id} className="py-2 text-xs">
                  <div className="flex items-center justify-between">
                    <b className="text-[#087e50]">
                      {lang === 'am' ? n.titleAm : n.titleEn}
                    </b>
                    <small className="text-[#7c9084]">{n.time}</small>
                  </div>
                  <p className="text-[#4a6656] mt-0.5">
                    {lang === 'am' ? n.bodyAm : n.bodyEn}
                  </p>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main View Switcher */}
      <main className="mt-4">
        {screen === 'home' && (
          <>
            <section className="welcome">
              <div>
                <small className="eyebrow">{copy.communityEyebrow}</small>
                <h1>{copy.welcomeTitle}</h1>
                <p>{copy.welcomeSub}</p>
              </div>
              <button
                type="button"
                onClick={() => setScreen('wallet')}
                className="balance text-left hover:border-[#12a566] transition-colors"
              >
                ◆{' '}
                <span>
                  <small>{copy.demoBalanceLabel}</small>
                  <b data-testid="home-demo-balance">{demoBalance.toFixed(2)} ETB</b>
                </span>
              </button>
            </section>

            <section className="hero">
              <div className="hero-text">
                <small>{copy.liveRoomEyebrow}</small>
                <h2>
                  {copy.heroTitleLine1}
                  <br />
                  <em>{copy.heroTitleEmphasis}</em>
                </h2>
                <p>{copy.heroSub}</p>
                <div className="flex flex-wrap items-center gap-2.5 mt-3">
                  <button
                    type="button"
                    data-start="true"
                    className="gold"
                    onClick={() => setScreen('game')}
                  >
                    {copy.exploreGameCta}
                  </button>
                  <button
                    type="button"
                    onClick={() => setScreen('cards')}
                    className="px-4 py-2.5 mt-2.5 rounded-xl bg-white/15 border border-white/30 text-white text-xs font-extrabold hover:bg-white/25 transition-colors"
                  >
                    {copy.pickCardsCta}
                  </button>
                </div>
              </div>
              <div className="hero-balls" aria-hidden="true">
                <i>B</i>
                <b>9</b>
                <i>7</i>
              </div>
              <div className="hero-foot">
                <span>{copy.heroFoot1}</span>
                <span>{copy.heroFoot2}</span>
                <span>
                  {copy.heroFoot3} · {lang === 'am' ? 'ሎቢ ቆጠራ፦' : 'Lobby Countdown:'}{' '}
                  <b className="font-mono tabular-nums">00:{String(countdown).padStart(2, '0')}</b>
                </span>
              </div>
            </section>

            <section className="stats">
              <article>
                <Users />
                <small>{copy.statPlayersOnline}</small>
                <b>{activeRoom.activePlayers}</b>
                <span className="stat-sub">{copy.statPlayersSub}</span>
              </article>
              <article>
                <Gift />
                <small>{copy.statRoomCapacity}</small>
                <b>{copy.statRoomCapacityValue}</b>
                <span className="stat-sub">{copy.statRoomCapacitySub}</span>
              </article>
              <article>
                <Wallet />
                <small>{copy.statCardPrice}</small>
                <b>{cardPrice} ETB</b>
                <span className="stat-sub">{copy.statCardPriceSub}</span>
              </article>
            </section>

            <section className="columns">
              <article className="panel">
                <div className="panel-title">
                  <div>
                    <small className="eyebrow">{copy.gameArenaEyebrow}</small>
                    <h3>{copy.liveCallerTitle}</h3>
                  </div>
                  <span className="live">{copy.demoLiveBadge}</span>
                </div>

                <div className="caller">
                  <BingoBall3D
                    number={latestBall}
                    size="xl"
                    animateEntry
                    reducedMotion={reducedMotion}
                  />
                  <div>
                    <b className="text-xs tracking-wider uppercase text-[#145b38] block">
                      {copy.numberCalledLabel}
                    </b>
                    <p className="text-xs text-[#698072] mt-1 tabular-nums">
                      {calls.length} {copy.numbersAnnouncedSuffix}
                    </p>
                    <button
                      type="button"
                      onClick={() => setScreen('game')}
                      className="mt-2 text-xs font-extrabold text-[#087e50] underline"
                    >
                      {lang === 'am' ? 'ሙሉ የጨዋታ ስክሪን ክፈት →' : 'Open Full Arena →'}
                    </button>
                  </div>
                </div>

                <small className="eyebrow">{copy.recentCallsLabel}</small>
                <div className="flex flex-wrap gap-1.5 my-3">
                  {calls
                    .slice()
                    .reverse()
                    .slice(0, 8)
                    .map((n, i) => (
                      <b
                        key={n}
                        className={`w-8 h-8 rounded-full grid place-items-center font-['Outfit'] text-xs font-bold tabular-nums ${
                          i === 0
                            ? 'bg-[#0c965b] text-white'
                            : 'bg-[#edf4ef] text-[#5b7664]'
                        }`}
                      >
                        {n}
                      </b>
                    ))}
                </div>

                <div className="controls">
                  <button
                    type="button"
                    className="outline"
                    onClick={handleResetRound}
                  >
                    {copy.resetDemoBtn}
                  </button>
                  <button
                    type="button"
                    className="green"
                    onClick={handleCallNextNumber}
                  >
                    {copy.callNextBtn}
                  </button>
                </div>
              </article>

              <article className="panel">
                <div className="panel-title">
                  <div>
                    <small className="eyebrow">{copy.playerCardEyebrow}</small>
                    <h3>{copy.yourBingoCardTitle}</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setScreen('cards')}
                    className="count hover:bg-[#d8f3e3]"
                  >
                    {selectedCardIds.length}/4 {lang === 'am' ? 'ካርድ (ቀይር)' : 'cards (Edit)'}
                  </button>
                </div>

                <div className="my-3 max-w-[380px] mx-auto">
                  <BingoCardView
                    card={playerCards[0]}
                    calledNumbers={calls}
                    markedNumbers={marked}
                    onToggleCell={handleToggleCellMark}
                    lang={lang}
                  />
                </div>

                <div className="text-center text-[11px] text-[#6d8375] my-2">
                  {copy.legendCalled}　 {copy.legendMarked}　 {copy.legendFree}
                </div>

                <div className="controls">
                  <button
                    type="button"
                    className="outline"
                    onClick={handleAddQuickCard}
                  >
                    {copy.addCardBtn}
                  </button>
                  <button
                    type="button"
                    className="green"
                    onClick={handleClaimBingo}
                  >
                    {copy.claimBingoBtn}
                  </button>
                </div>
                <p className="text-center text-[11px] text-[#7a8f82] mt-2 mb-0">
                  {copy.cardHint}
                </p>
              </article>
            </section>

            <section className="extras">
              <article
                onClick={() => setScreen('referral')}
                className="cursor-pointer hover:border-[#12a566] transition-colors"
              >
                <Gift size={26} />
                <div>
                  <small>{copy.inviteEyebrow}</small>
                  <b>{copy.inviteTitle}</b>
                  <p>{copy.inviteDesc}</p>
                </div>
              </article>
              <article
                onClick={() => setScreen('support')}
                className="cursor-pointer hover:border-[#12a566] transition-colors"
              >
                <Headphones size={26} />
                <div>
                  <small>{copy.supportEyebrow}</small>
                  <b>{copy.supportTitle}</b>
                  <p>{copy.supportDesc}</p>
                </div>
              </article>
            </section>
          </>
        )}

        {(screen === 'lobby' || screen === 'cards') && (
          <LobbyAndCardsScreen
            mode={screen}
            lang={lang}
            rooms={rooms}
            activeRoom={activeRoom}
            onSelectRoom={(id) => {
              setActiveRoomId(id);
              const rm = rooms.find((r) => r.id === id);
              if (rm) setCardPrice(rm.cardPrice);
            }}
            selectedCardIds={selectedCardIds}
            onToggleCardId={handleToggleCardId}
            onQuickPickCards={handleQuickPickCards}
            onClearSelectedCards={() => setSelectedCardIds([])}
            countdown={countdown}
            onResetCountdown={() => setCountdown(DEFAULT_GAME_RULES.lobbyCountdownSeconds)}
            cardPrice={cardPrice}
            onChangeCardPrice={setCardPrice}
            demoBalance={demoBalance}
            onEnterLiveGame={handleEnterLiveGame}
            onNavigate={setScreen}
          />
        )}

        {screen === 'game' && (
          <LiveGameScreen
            lang={lang}
            activeRoom={activeRoom}
            cardPrice={cardPrice}
            playerCards={playerCards}
            calledNumbers={calls}
            markedNumbers={marked}
            autoMark={autoMark}
            onToggleAutoMark={() => setAutoMark((v) => !v)}
            autoCallerActive={autoCallerActive}
            onToggleAutoCaller={() => setAutoCallerActive((v) => !v)}
            callerIntervalSec={callerIntervalSec}
            onChangeCallerInterval={setCallerIntervalSec}
            onCallNextBall={handleCallNextNumber}
            onCallHelpfulBall={handleCallHelpfulNumber}
            onResetRound={handleResetRound}
            onToggleMarkCell={handleToggleCellMark}
            onAddQuickCard={handleAddQuickCard}
            onRemoveCard={(cid) => handleToggleCardId(cid)}
            onClaimBingo={handleClaimBingo}
            reducedMotion={reducedMotion}
            onNavigate={setScreen}
          />
        )}

        {(screen === 'wallet' || screen === 'deposit' || screen === 'withdraw') && (
          <WalletScreens
            mode={screen}
            lang={lang}
            demoBalance={demoBalance}
            transactions={transactions}
            onSimulateDeposit={handleSimulateDeposit}
            onSimulateWithdraw={handleSimulateWithdraw}
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
            onChangeLang={setLang}
            user={user}
            firebaseUserEmail={fbUser?.email || null}
            firebaseUid={fbUser?.uid || null}
            firestoreConnected={firestoreConnected}
            onSignInGoogle={handleSignInGoogle}
            onSignOutFirebase={handleSignOutFirebase}
            phoneNumber={phoneNumber}
            phoneVerified={phoneVerified}
            onVerifyPhone={handleVerifyPhone}
            telegramBackendStatus={telegramBackendStatus}
            onValidateTelegramInitData={handleValidateTelegramInitData}
            demoBalance={demoBalance}
            referrals={referrals}
            onSimulateFriendJoin={handleSimulateFriendJoin}
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
        winningCard={winningCardObj}
        calledNumbers={calls}
        markedNumbers={marked}
        prizeDemoEtb={Math.max(50, effectiveCardIds.length * cardPrice * 4)}
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
            <button
              type="button"
              onClick={() => setToast('')}
              aria-label="Dismiss notification"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile-First Bottom Navigation Bar */}
      <nav className="bottom-nav" aria-label="Primary Bottom Navigation">
        <button
          type="button"
          className={screen === 'home' ? 'selected' : ''}
          onClick={() => setScreen('home')}
        >
          <Home />
          {copy.navHome}
        </button>
        <button
          type="button"
          className={screen === 'lobby' ? 'selected' : ''}
          onClick={() => setScreen('lobby')}
        >
          <Clock />
          {copy.navLobby}
        </button>
        <button
          type="button"
          className={screen === 'cards' ? 'selected' : ''}
          onClick={() => setScreen('cards')}
        >
          <Grid />
          {copy.navCards}
        </button>
        <button
          type="button"
          className={screen === 'game' ? 'selected' : ''}
          onClick={() => setScreen('game')}
        >
          <Sparkles />
          {copy.navGame}
        </button>
        <button
          type="button"
          className={
            screen === 'wallet' || screen === 'deposit' || screen === 'withdraw'
              ? 'selected'
              : ''
          }
          onClick={() => setScreen('wallet')}
        >
          <Wallet />
          {copy.navWallet}
        </button>
        <button
          type="button"
          className={screen === 'referral' ? 'selected' : ''}
          onClick={() => setScreen('referral')}
        >
          <Users />
          {copy.navFriends}
        </button>
        <button
          type="button"
          className={
            screen === 'profile' || screen === 'support' || screen === 'terms'
              ? 'selected'
              : ''
          }
          onClick={() => setScreen('profile')}
        >
          <FileText />
          {copy.navProfile}
        </button>
      </nav>

      <footer className="adey-footer">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <span>
            © 2026 ADEYBINGO · FIREBASE PROJECT: gen-lang-client-0559010770 · DEMO SANDBOX
          </span>
          <button
            type="button"
            onClick={() => setScreen('terms')}
            className="underline hover:text-[#087e50] bg-transparent border-0 p-0"
          >
            {lang === 'am' ? 'ህጎች እና ደንቦች' : 'Terms & Rules'}
          </button>
          <button
            type="button"
            onClick={() => setScreen('support')}
            className="underline hover:text-[#087e50] bg-transparent border-0 p-0"
          >
            {lang === 'am' ? 'የተጫዋቾች ድጋፍ' : 'Player Support'}
          </button>
        </div>
      </footer>
    </div>
  );
}
