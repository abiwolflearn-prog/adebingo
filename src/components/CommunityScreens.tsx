import { useState } from 'react';
import {
  Gift,
  Copy,
  Check,
  User,
  History,
  Headphones,
  FileText,
  Send,
  ShieldCheck,
  Phone,
  LogIn,
  LogOut,
  Database,
  Lock,
  Trophy,
  TicketPercent,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  GameHistoryItem,
  Language,
  LeaderboardEntry,
  ReferralRecord,
  ScreenId,
  SupportTicket,
} from '../types/bingo';
import { t } from '../utils/i18n';
import { TelegramUserProfile } from '../utils/telegram';
import { TelegramBotConsole } from './TelegramBotConsole';

interface CommunityScreensProps {
  mode: 'leaderboard' | 'referral' | 'profile' | 'support' | 'terms';
  lang: Language;
  onChangeLang: (lang: Language) => void;
  user: TelegramUserProfile;
  firebaseUserEmail: string | null;
  firebaseUid: string | null;
  firestoreConnected: boolean;
  onSignInGoogle: () => void;
  onSignOutFirebase: () => void;
  phoneNumber: string;
  phoneVerified: boolean;
  onVerifyPhone: (phone: string, method: 'telegram_contact' | 'sms_otp_demo') => Promise<void>;
  serverVerifiedTelegramId: number | null;
  telegramBackendStatus: string;
  onValidateTelegramInitData: () => Promise<void>;
  referralCode?: string;
  referrals: ReferralRecord[];
  leaderboard: LeaderboardEntry[];
  onApplyPromoCode?: (code: string) => Promise<{ ok: boolean; message: string }>;
  gameHistory: GameHistoryItem[];
  tickets: SupportTicket[];
  onSubmitSupportTicket: (category: string, subject: string, message: string) => void;
  reducedMotion: boolean;
  onToggleReducedMotion: () => void;
  onNavigate: (screen: ScreenId) => void;
}

const FAQ_ITEMS = [
  {
    qAm: 'በአንድ የጨዋታ ክፍል ውስጥ ስንት ካርዶች አሉ?',
    qEn: 'How many Bingo cards are in each room?',
    aAm: 'እያንዳንዱ የጨዋታ ክፍል ከ #1 እስከ #600 የተቆጠሩ ልዩ 5x5 የቢንጎ ካርዶች አሉት። አንድ ተጫዋች በአንድ ዙር ከ1 እስከ 4 ካርድ መምረጥ ይችላል።',
    aEn: 'Each game room contains 600 unique, deterministic 5x5 Bingo cards (#1–#600). Each player can select between 1 and 4 cards per round.',
  },
  {
    qAm: 'የካርድ ምርጫ በFirebase እንዴት ይጠበቃል?',
    qEn: 'How are card reservations protected in Cloud Firestore?',
    aAm: 'ካርድ ሲመርጡ በአቶሚክ Firestore ትራንዛክሽን (runTransaction) ስለሚመዘገብ አንድ ካርድ በሁለት ተጫዋቾች በተመሳሳይ ጊዜ አይያዝም።',
    aEn: 'Card reservations use atomic Firestore transactions (runTransaction) and strict Security Rules (existsAfter/getAfter) to prevent duplicate reservations and enforce the 4-card limit.',
  },
  {
    qAm: 'የስልክ ቁጥሬ ደህንነት እንዴት ይጠበቃል?',
    qEn: 'How is my phone number protected?',
    aAm: 'የስልክ ቁጥርዎ ከህዝብ መገለጫ ተለይቶ በ /users/{uid}/private/contact ውስጥ የሚቀመጥ ሲሆን ከእርስዎ በስተቀር ማንም ሊያየው አይችልም።',
    aEn: 'Your phone number is isolated in a private Firestore subcollection (/users/{uid}/private/contact) readable only by your authenticated UID.',
  },
];

export function CommunityScreens({
  mode,
  lang,
  onChangeLang,
  user,
  firebaseUserEmail,
  firebaseUid,
  firestoreConnected,
  onSignInGoogle,
  onSignOutFirebase,
  phoneNumber,
  phoneVerified,
  onVerifyPhone,
  serverVerifiedTelegramId,
  telegramBackendStatus,
  onValidateTelegramInitData,
  referralCode,
  referrals,
  leaderboard,
  onApplyPromoCode,
  gameHistory,
  tickets,
  onSubmitSupportTicket,
  reducedMotion,
  onToggleReducedMotion,
  onNavigate,
}: CommunityScreensProps) {
  const copy = t(lang);
  const [copied, setCopied] = useState(false);
  const [copiedTelegramId, setCopiedTelegramId] = useState(false);
  const [promoCodeInput, setPromoCodeInput] = useState('');
  const [promoFeedback, setPromoFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);

  const [phoneInput, setPhoneInput] = useState(phoneNumber || '+251911223344');
  const [phoneMethod, setPhoneMethod] = useState<'telegram_contact' | 'sms_otp_demo'>(
    'telegram_contact'
  );
  const [phoneError, setPhoneError] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);

  const [ticketCategory, setTicketCategory] = useState('game_rules');
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketMessage, setTicketMessage] = useState('');
  const [ticketError, setTicketError] = useState('');
  const [showAdvancedBot, setShowAdvancedBot] = useState(false);

  const effectiveRefCode = referralCode || `ADEY-${user.id}`;
  const inviteLink = `https://t.me/AdeyBingoBot?start=${effectiveRefCode}`;

  const copyTextSafely = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {
      // Fallback below for restricted WebViews / iframes
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch {
      // Ignore in restricted environments
    }
  };

  const handleCopyInvite = () => {
    void copyTextSafely(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyTelegramId = () => {
    if (serverVerifiedTelegramId === null) return;
    void copyTextSafely(String(serverVerifiedTelegramId));
    setCopiedTelegramId(true);
    setTimeout(() => setCopiedTelegramId(false), 2000);
  };

  const handleApplyReferralSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onApplyPromoCode) return;
    const trimmed = promoCodeInput.trim();
    if (!trimmed) return;
    setPromoBusy(true);
    setPromoFeedback(null);
    try {
      const res = await onApplyPromoCode(trimmed);
      setPromoFeedback({ ok: res.ok, text: res.message });
      if (res.ok) setPromoCodeInput('');
    } finally {
      setPromoBusy(false);
    }
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = phoneInput.replace(/[\s\-()]/g, '');
    if (!/^\+?[0-9]{9,15}$/.test(cleaned)) {
      setPhoneError(
        lang === 'am'
          ? 'እባክዎ ትክክለኛ የስልክ ቁጥር ያስገቡ (ምሳሌ፦ +251911223344)'
          : 'Please enter a valid 9–15 digit phone number (e.g. +251911223344).'
      );
      return;
    }
    setPhoneError('');
    setPhoneBusy(true);
    try {
      await onVerifyPhone(cleaned, phoneMethod);
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhoneBusy(false);
    }
  };

  const handleSupportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (ticketSubject.trim().length < 3 || ticketMessage.trim().length < 6) {
      setTicketError(
        lang === 'am'
          ? 'እባክዎ ርዕስ እና ዝርዝር መልዕክትዎን በትክክል ይጻፉ።'
          : 'Please enter both a subject and a detailed message.'
      );
      return;
    }
    setTicketError('');
    onSubmitSupportTicket(ticketCategory, ticketSubject.trim(), ticketMessage.trim());
    setTicketSubject('');
    setTicketMessage('');
  };

  return (
    <div className="space-y-4">
      {/* Sub-navigation bar ONLY for Profile, Referral, Support, and Terms (Leaderboard has its own dedicated bottom tab) */}
      {mode !== 'leaderboard' && (
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-1.5 bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-2">
          {(
            [
              { id: 'profile', icon: User, am: 'መገለጫ እና ደህንነት', en: 'Profile & Security' },
              { id: 'referral', icon: Gift, am: 'ጓደኛ ይጋብዙ (+20 ብር)', en: 'Referrals (+20 ETB)' },
              { id: 'support', icon: Headphones, am: 'እገዛ', en: 'Support' },
              { id: 'terms', icon: FileText, am: 'ደንቦች', en: 'Terms' },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = mode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onNavigate(tab.id)}
                className={`px-3 py-2.5 rounded-xl text-xs font-extrabold flex items-center justify-center sm:justify-start gap-1.5 transition-colors min-h-[42px] ${
                  active
                    ? 'bg-gradient-to-r from-cyan-400 to-sky-500 text-[#041421]'
                    : 'text-slate-300 hover:bg-[#14223b]'
                }`}
              >
                <Icon size={14} />
                {lang === 'am' ? tab.am : tab.en}
              </button>
            );
          })}
        </div>
      )}

      {/* 0. LEADERBOARD & GAME HISTORY SCREEN */}
      {mode === 'leaderboard' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <section className="lg:col-span-7 bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-400/30 flex items-center justify-center text-[#facc15]">
                  <Trophy size={20} />
                </div>
                <div>
                  <h2 className="font-['Outfit'] text-xl font-extrabold text-white">
                    {copy.leaderboardTitle}
                  </h2>
                  <p className="text-xs text-slate-400">{copy.leaderboardSub}</p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-lg bg-[#14223b] border border-slate-700 text-xs font-extrabold text-cyan-300 tabular-nums">
                {leaderboard.length}
              </span>
            </div>

            {leaderboard.length === 0 ? (
              <div
                data-testid="leaderboard-empty-state"
                className="p-8 rounded-2xl bg-[#14223b] border border-slate-700/50 text-center space-y-2"
              >
                <div className="w-11 h-11 rounded-2xl bg-slate-800/80 border border-slate-700 mx-auto flex items-center justify-center text-slate-400">
                  <Trophy size={20} />
                </div>
                <p className="text-sm font-extrabold text-slate-200">
                  {copy.emptyLeaderboardTitle}
                </p>
                <p className="text-xs text-slate-400 max-w-sm mx-auto">
                  {copy.emptyLeaderboardDesc}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {leaderboard.map((entry, idx) => {
                  const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
                  return (
                    <div
                      key={entry.uid}
                      className="py-3 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="w-8 h-8 rounded-xl bg-[#14223b] border border-slate-700 flex items-center justify-center text-sm font-extrabold text-[#facc15] shrink-0">
                          {medal}
                        </span>
                        <div className="min-w-0">
                          <b className="text-sm font-extrabold text-white block truncate">
                            {entry.displayName}
                          </b>
                          <small className="text-[11px] font-mono text-slate-400">
                            {entry.wins} {lang === 'am' ? 'ድሎች' : 'wins'}
                          </small>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <b className="font-['Outfit'] text-sm font-extrabold text-[#facc15] tabular-nums block">
                          {entry.winningsEtb.toFixed(2)} ETB
                        </b>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="lg:col-span-5 bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-['Outfit'] text-lg font-extrabold text-white flex items-center gap-2">
                <History size={18} className="text-cyan-400" />
                {lang === 'am' ? 'የእኔ የጨዋታ ታሪክ' : 'My Game History'}
              </h3>
              <span className="text-xs font-bold text-slate-400 tabular-nums">
                {gameHistory.length} {lang === 'am' ? 'ዙሮች' : 'rounds'}
              </span>
            </div>

            {gameHistory.length === 0 ? (
              <div className="p-6 rounded-2xl bg-[#14223b] border border-slate-700/50 text-center space-y-1.5">
                <Sparkles size={20} className="mx-auto text-slate-500" />
                <p className="text-xs font-extrabold text-slate-200">
                  {lang === 'am' ? 'ምንም የጨዋታ ታሪክ የለም' : 'No game history yet'}
                </p>
                <p className="text-[11px] text-slate-400">
                  {lang === 'am'
                    ? 'ጨዋታ ሲያጠናቅቁ ውጤቶችዎ እዚህ ይቀመጣሉ።'
                    : 'Completed Bingo rounds will appear here automatically.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {gameHistory.map((item) => (
                  <div key={item.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <b className="text-xs font-extrabold text-white block truncate">
                        {lang === 'am' ? item.roomNameAm : item.roomNameEn}
                      </b>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        <span>{item.playedAt}</span>
                        {item.cardIds.length > 0 && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span>
                              {lang === 'am' ? 'ካርድ፦' : 'Cards:'}{' '}
                              {item.cardIds.map((c) => `#${c}`).join(', ')}
                            </span>
                          </>
                        )}
                        {item.winningBall && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span>
                              {lang === 'am' ? 'ኳስ፦' : 'Ball:'} {item.winningBall}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <b
                        className={`font-['Outfit'] text-sm font-extrabold tabular-nums block ${
                          item.outcome === 'won' ? 'text-[#facc15]' : 'text-slate-400'
                        }`}
                      >
                        {item.outcome === 'won'
                          ? `+${item.prizeDemo.toFixed(2)} ETB`
                          : `${item.entryFeeDemo.toFixed(2)} ETB`}
                      </b>
                      <small className="text-[10px] text-slate-500 tabular-nums">
                        {item.callsCount} {lang === 'am' ? 'ጥሪዎች' : 'calls'}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 1. REFERRAL SYSTEM SCREEN */}
      {mode === 'referral' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <section className="lg:col-span-5 bg-gradient-to-br from-[#0e203d] via-[#13294b] to-[#0d2d45] border border-cyan-500/30 text-white rounded-3xl p-6 space-y-4 shadow-xl">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#facc15]">
              ✦ {lang === 'am' ? 'ይጋብዙ እና ያድጉ · 15 ብር የመቀላቀያ ቦነስ' : 'INVITE & GROW · 15 ETB JOIN BONUS'}
            </span>
            <h2 className="font-['Outfit'] text-2xl sm:text-3xl font-extrabold leading-tight">
              {lang === 'am'
                ? 'ሲቀላቀሉ 15 ብር · ጓደኛ ሲጋብዙ +20 ብር ቦነስ!'
                : 'Get 15 Birr on Join & +20 Birr for Invited Friends!'}
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed">
              {lang === 'am'
                ? 'እያንዳንዱ አዲስ ተጫዋች ሲቀላቀል 15 ብር ያገኛል፤ የተጋበዙ ጓደኞች ደግሞ +20 ብር ቦነስ ያገኛሉ። ያለ በቂ ሂሳብ እና ካርድ መጫወት ስለማይቻል ጓደኞችዎን ይጋብዙ!'
                : 'Every player gets 15 Birr when they join, and invited friends get +20 Birr bonus! Players cannot play without balance & a card — share your invite code below.'}
            </p>

            <div className="bg-[#070d19]/75 border border-slate-700/60 p-3.5 rounded-2xl space-y-2">
              <small className="text-[10px] uppercase tracking-wider text-cyan-300 block font-bold">
                {lang === 'am' ? 'የእርስዎ የግብዣ ሊንክ' : 'YOUR PERSONAL INVITE LINK'}
              </small>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono truncate bg-[#14223b] text-slate-100 px-3 py-2 rounded-xl border border-slate-700/70">
                  {inviteLink}
                </code>
                <button
                  type="button"
                  onClick={handleCopyInvite}
                  className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-[#facc15] to-[#f59e0b] text-[#1e1402] text-xs font-extrabold flex items-center gap-1 shrink-0"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied
                    ? lang === 'am'
                      ? 'ተቀድቷል'
                      : 'Copied'
                    : lang === 'am'
                    ? 'ቅዳ'
                    : 'Copy'}
                </button>
              </div>
              <div className="text-[11px] font-mono text-slate-400">
                {lang === 'am' ? 'የእርስዎ ኮድ፦' : 'Your code:'}{' '}
                <b className="text-cyan-300">{effectiveRefCode}</b>
              </div>
            </div>

            {onApplyPromoCode && (
              <form
                onSubmit={handleApplyReferralSubmit}
                className="bg-[#070d19]/60 border border-slate-700/60 rounded-2xl p-3.5 space-y-2.5"
              >
                <small className="text-[11px] font-bold text-cyan-300 flex items-center gap-1.5">
                  <TicketPercent size={14} />
                  {copy.promoSectionTitle}
                </small>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={promoCodeInput}
                    onChange={(e) => setPromoCodeInput(e.target.value)}
                    placeholder={copy.promoPlaceholder}
                    aria-label={copy.promoSectionTitle}
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-[#14223b] border border-slate-700 text-white text-xs font-mono font-bold placeholder:text-slate-500"
                  />
                  <button
                    type="submit"
                    disabled={promoBusy || !promoCodeInput.trim()}
                    className="px-3.5 py-2 rounded-xl bg-cyan-400 text-[#041421] text-xs font-extrabold shrink-0 disabled:opacity-50"
                  >
                    {promoBusy ? '...' : copy.applyPromoBtn}
                  </button>
                </div>
                {promoFeedback && (
                  <p
                    className={`text-xs font-bold ${
                      promoFeedback.ok ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {promoFeedback.text}
                  </p>
                )}
              </form>
            )}
          </section>

          <section className="lg:col-span-7 bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-['Outfit'] text-xl font-extrabold text-white">
                {lang === 'am'
                  ? `የተጋበዙ ጓደኞች (${referrals.length})`
                  : `Invited Friends (${referrals.length})`}
              </h3>
              <span className="text-xs font-extrabold text-[#facc15] tabular-nums">
                +
                {referrals
                  .filter((r) => r.status === 'qualified')
                  .reduce((sum, r) => sum + r.inviterBonus, 0)}{' '}
                ETB
              </span>
            </div>

            {referrals.length === 0 ? (
              <div className="p-8 rounded-2xl bg-[#14223b] border border-slate-700/50 text-center space-y-1.5">
                <Gift size={22} className="mx-auto text-slate-500" />
                <p className="text-sm font-extrabold text-slate-200">
                  {lang === 'am' ? 'እስካሁን የተጋበዙ ጓደኞች የሉም' : 'No referred friends yet'}
                </p>
                <p className="text-xs text-slate-400">
                  {lang === 'am'
                    ? 'ሊንክዎን ሲያጋሩ እና ጓደኛዎ ሲቀላቀል እዚህ ይታያል።'
                    : 'Share your personal link above to track verified friend referrals here.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-800/80">
                {referrals.map((ref) => (
                  <div key={ref.id} className="py-3.5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="w-9 h-9 rounded-full bg-cyan-500/15 border border-cyan-400/30 text-cyan-300 font-extrabold text-xs flex items-center justify-center">
                        {ref.friendName.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <b className="text-xs font-extrabold text-white block">
                          {ref.friendName}{' '}
                          <span className="font-normal text-slate-400">{ref.handle}</span>
                        </b>
                        <small className="text-[11px] text-slate-400">{ref.joinedAt}</small>
                      </div>
                    </div>

                    <div className="text-right">
                      <b className="font-['Outfit'] text-sm font-extrabold text-[#facc15] tabular-nums block">
                        +{ref.inviterBonus} ETB
                      </b>
                      <small className="text-[10px] text-emerald-300">
                        {ref.status === 'qualified'
                          ? lang === 'am'
                            ? '✓ የተረጋገጠ'
                            : '✓ Qualified'
                          : lang === 'am'
                          ? 'በመጠባበቅ ላይ'
                          : 'Pending'}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 2. PROFILE, FIREBASE AUTH & PII PHONE VERIFICATION (CLEAN & DEDUPLICATED) */}
      {mode === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <section className="lg:col-span-6 space-y-4 min-w-0">
            {/* Player Identity & Firebase Authentication Card */}
            <div className="bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-400 to-sky-600 text-[#041421] font-['Outfit'] text-2xl font-extrabold flex items-center justify-center shadow-md shrink-0">
                  {user.initials}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-[10px] font-extrabold uppercase text-cyan-400 block truncate">
                    {firebaseUid
                      ? 'TELEGRAM MINI APP · CLOUD SYNC ACTIVE'
                      : 'TELEGRAM MINI APP · SESSION'}
                  </span>
                  <h2 className="font-['Outfit'] text-2xl font-extrabold text-white truncate">
                    {user.firstName} {user.lastName}
                  </h2>
                  <p className="text-xs text-slate-400 font-mono truncate">
                    {user.username} · TG #{user.id}
                  </p>
                  {firebaseUserEmail && (
                    <p className="text-[11px] text-emerald-300 font-bold truncate mt-0.5">
                      ✓ {firebaseUserEmail}
                    </p>
                  )}
                </div>
              </div>

              {/* Telegram Mini App Server Auth / Sign-Out Action */}
              <div className="p-3.5 rounded-2xl bg-[#14223b] border border-slate-700/60 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-200 flex items-center gap-1.5">
                    <Database size={14} className="text-cyan-400" />
                    {lang === 'am' ? 'Cloud Firestore ግንኙነት' : 'Cloud Firestore Status'}
                  </span>
                  <span className="font-mono text-[11px] font-bold text-cyan-300">
                    {firestoreConnected ? 'CONNECTED' : 'CHECKING'}
                  </span>
                </div>

                {firebaseUid ? (
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-[11px] font-mono text-slate-400 truncate">
                      UID: {firebaseUid.slice(0, 14)}...
                    </span>
                    <button
                      type="button"
                      onClick={onSignOutFirebase}
                      className="px-3 py-1.5 rounded-xl border border-slate-600 bg-[#0b1322] text-slate-200 text-xs font-extrabold flex items-center gap-1.5 hover:border-cyan-400/40"
                    >
                      <LogOut size={13} />
                      {lang === 'am' ? 'ውጣ' : 'Disconnect'}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={onSignInGoogle}
                    className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-400 to-sky-500 text-[#041421] text-xs font-extrabold flex items-center justify-center gap-2 shadow-xs hover:brightness-105 min-h-[44px]"
                  >
                    <LogIn size={15} />
                    {lang === 'am'
                      ? 'በቴሌግራም ያረጋግጡ (Telegram Mini App Auth)'
                      : 'Authenticate via Telegram Mini App'}
                  </button>
                )}
              </div>
            </div>

            {/* Server-Verified "My Telegram ID" Section */}
            <div
              data-testid="my-telegram-id-section"
              className="bg-[#0f1a2e] border border-cyan-500/35 rounded-2xl p-5 space-y-3 shadow-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[10px] font-extrabold uppercase text-cyan-400 flex items-center gap-1">
                    <ShieldCheck size={12} />
                    {lang === 'am'
                      ? 'በሰርቨር የተረጋገጠ (SERVER-VERIFIED INITDATA)'
                      : 'SERVER-VERIFIED INITDATA'}
                  </span>
                  <h3 className="font-['Outfit'] text-lg font-extrabold text-white">
                    {lang === 'am' ? 'የእኔ የቴሌግራም መለያ (My Telegram ID)' : 'My Telegram ID'}
                  </h3>
                </div>
                <span
                  className={`text-[11px] font-extrabold px-2.5 py-1 rounded-lg shrink-0 ${
                    serverVerifiedTelegramId !== null
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  }`}
                >
                  {serverVerifiedTelegramId !== null
                    ? lang === 'am'
                      ? '✓ የተረጋገጠ'
                      : '✓ Verified'
                    : lang === 'am'
                    ? 'በቴሌግራም ይክፈቱ'
                    : 'Awaiting Telegram'}
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                {lang === 'am'
                  ? 'ይህ ቁጥር የሚገኘው ከቴሌግራም Mini App የተፈረመ initData በሰርቨር ላይ ከተረጋገጠ በኋላ ብቻ ነው።'
                  : 'Retrieved exclusively from cryptographically verified Telegram Mini App initData on the server.'}
              </p>

              <div className="flex items-center justify-between gap-2 p-3 rounded-xl bg-[#14223b] border border-slate-700/70">
                <div className="min-w-0">
                  <span className="text-[10px] font-bold uppercase text-slate-400 block">
                    {lang === 'am' ? 'የተረጋገጠ የቴሌግራም ቁጥር' : 'Verified Numeric Telegram ID'}
                  </span>
                  <code
                    data-testid="verified-telegram-id-value"
                    className="font-mono text-base font-extrabold text-white select-all block truncate"
                  >
                    {serverVerifiedTelegramId !== null
                      ? String(serverVerifiedTelegramId)
                      : lang === 'am'
                      ? 'በቴሌግራም Mini App ውስጥ ሲከፍቱ ይታያል'
                      : 'Open in Telegram Mini App to verify'}
                  </code>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    data-testid="copy-telegram-id-btn"
                    disabled={serverVerifiedTelegramId === null}
                    onClick={handleCopyTelegramId}
                    className={`px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-colors min-h-[40px] ${
                      serverVerifiedTelegramId !== null
                        ? 'bg-cyan-400 text-[#041421] hover:brightness-105 cursor-pointer'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    }`}
                  >
                    {copiedTelegramId ? <Check size={14} /> : <Copy size={14} />}
                    {copiedTelegramId
                      ? lang === 'am'
                        ? 'ተቀድቷል!'
                        : 'Copied!'
                      : lang === 'am'
                      ? 'ቅዳ (Copy)'
                      : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="lg:col-span-6 space-y-4 min-w-0">
            {/* Secure Phone Number Registration & Verification (PII-Isolated Subcollection) */}
            <form
              onSubmit={handlePhoneSubmit}
              className="bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[10px] font-extrabold uppercase text-cyan-400 flex items-center gap-1">
                    <Lock size={12} />
                    {lang === 'am' ? 'የግል መረጃ ጥበቃ (PII ISOLATED)' : 'PII-ISOLATED SUBCOLLECTION'}
                  </span>
                  <h3 className="font-['Outfit'] text-lg font-extrabold text-white">
                    {lang === 'am' ? 'የስልክ ቁጥር ምዝገባ እና ማረጋገጫ' : 'Phone Registration & Verification'}
                  </h3>
                </div>
                <span
                  className={`text-[11px] font-extrabold px-2.5 py-1 rounded-lg shrink-0 ${
                    phoneVerified
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                  }`}
                >
                  {phoneVerified
                    ? lang === 'am'
                      ? '✓ የተረጋገጠ'
                      : '✓ Verified'
                    : lang === 'am'
                    ? 'አልተረጋገጠም'
                    : 'Unverified'}
                </span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed break-words">
                {lang === 'am'
                  ? 'ስልክ ቁጥርዎ በ /users/{uid}/private/contact ውስጥ በጥብቅ ደህንነት ይቀመጣል።'
                  : 'Stored strictly in /users/{uid}/private/contact — inaccessible to other players.'}
              </p>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  {lang === 'am' ? 'የማረጋገጫ ዘዴ' : 'Verification Method'}
                </label>
                <select
                  value={phoneMethod}
                  onChange={(e) =>
                    setPhoneMethod(e.target.value as 'telegram_contact' | 'sms_otp_demo')
                  }
                  aria-label="Phone Verification Method"
                  className="w-full px-3 py-2.5 rounded-xl border border-slate-700 bg-[#14223b] text-xs font-bold text-white min-h-[42px]"
                >
                  <option value="telegram_contact">
                    {lang === 'am'
                      ? 'የቴሌግራም ስልክ ማጋሪያ (Telegram Contact)'
                      : 'Telegram Contact Share'}
                  </option>
                  <option value="sms_otp_demo">
                    {lang === 'am' ? 'የአጭር መልዕክት ኮድ (SMS OTP Demo)' : 'SMS OTP Verification (Demo)'}
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  {lang === 'am' ? 'የስልክ ቁጥር' : 'Phone Number'}
                </label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="+251911223344"
                    aria-label="Phone Number for Verification"
                    className="flex-1 min-w-0 px-3 py-2.5 rounded-xl border border-slate-700 bg-[#14223b] text-xs font-mono font-bold text-white min-h-[42px]"
                  />
                  <button
                    type="submit"
                    disabled={phoneBusy}
                    className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-400 to-sky-500 text-[#041421] text-xs font-extrabold flex items-center gap-1.5 shrink-0 min-h-[42px]"
                  >
                    <Phone size={13} />
                    {phoneBusy ? '...' : lang === 'am' ? 'አረጋግጥ' : 'Verify'}
                  </button>
                </div>
              </div>

              {phoneError && <p className="text-xs font-bold text-rose-400">{phoneError}</p>}
            </form>

            {/* Motion Accessibility & Collapsible Telegram Bot Diagnostics */}
            <div className="bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-3">
              <div className="flex items-center justify-between p-3 rounded-xl bg-[#14223b] border border-slate-700/60">
                <div>
                  <span className="text-xs font-bold text-slate-200 block">
                    {lang === 'am' ? 'እንቅስቃሴ ቀንስ (Reduced Motion)' : 'Reduced Motion Mode'}
                  </span>
                  <small className="text-[11px] text-slate-400">
                    {lang === 'am'
                      ? 'የ3D ኳስ እና የድል አኒሜሽን ያቃልላል'
                      : 'Simplifies 3D ball & celebration animations'}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={onToggleReducedMotion}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold min-h-[38px] ${
                    reducedMotion
                      ? 'bg-cyan-400 text-[#041421]'
                      : 'bg-[#070d19] text-slate-400 border border-slate-700'
                  }`}
                >
                  {reducedMotion ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="rounded-xl border border-slate-700/50 overflow-hidden bg-[#14223b]/50">
                <button
                  type="button"
                  onClick={() => setShowAdvancedBot((prev) => !prev)}
                  className="w-full px-4 py-3 flex items-center justify-between text-xs font-bold text-slate-300 hover:bg-[#14223b] min-h-[44px]"
                >
                  <span>
                    {lang === 'am'
                      ? 'የቴሌግራም ቦት እና የቴክኒክ ምርመራ'
                      : 'Telegram Bot & Diagnostics'}
                  </span>
                  {showAdvancedBot ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>

                {showAdvancedBot && (
                  <div className="p-4 pt-2 space-y-4 border-t border-slate-800/70">
                    <div className="p-3.5 rounded-2xl bg-[#0b1322] border border-slate-700/60 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-extrabold text-white">
                          {lang === 'am'
                            ? 'የቴሌግራም initData የሰርቨር ማረጋገጫ'
                            : 'Telegram initData Backend Check'}
                        </span>
                        <button
                          type="button"
                          onClick={onValidateTelegramInitData}
                          className="px-2.5 py-1.5 rounded-lg bg-cyan-500/15 border border-cyan-400/30 text-cyan-300 text-[11px] font-extrabold hover:bg-cyan-500/25 shrink-0"
                        >
                          {lang === 'am' ? 'አሁን ፈትሽ' : 'Verify on Server'}
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-400 font-mono leading-relaxed break-words">
                        {telegramBackendStatus}
                      </p>
                    </div>

                    <TelegramBotConsole
                      lang={lang}
                      user={user}
                      firebaseUid={firebaseUid}
                      onSyncLanguage={onChangeLang}
                      onPhoneVerifiedFromBot={(phone) => {
                        setPhoneInput(phone);
                        onVerifyPhone(phone, 'telegram_contact').catch(() => {});
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* 3. SUPPORT SCREEN */}
      {mode === 'support' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <section className="lg:col-span-6 bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-4">
            <h3 className="font-['Outfit'] text-xl font-extrabold text-white">
              {lang === 'am' ? 'ተደጋጋሚ ጥያቄዎች (FAQ)' : 'Frequently Asked Questions'}
            </h3>
            <div className="space-y-3">
              {FAQ_ITEMS.map((faq, idx) => (
                <div
                  key={idx}
                  className="p-4 rounded-2xl bg-[#14223b] border border-slate-700/60 space-y-1.5"
                >
                  <b className="text-xs font-extrabold text-cyan-300 block">
                    {lang === 'am' ? faq.qAm : faq.qEn}
                  </b>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {lang === 'am' ? faq.aAm : faq.aEn}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="lg:col-span-6 bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-5 space-y-4">
            <h3 className="font-['Outfit'] text-xl font-extrabold text-white">
              {lang === 'am' ? 'የድጋፍ መልዕክት ይላኩ' : 'Contact Player Support'}
            </h3>

            <form onSubmit={handleSupportSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  {lang === 'am' ? 'ምድብ' : 'Topic'}
                </label>
                <select
                  value={ticketCategory}
                  onChange={(e) => setTicketCategory(e.target.value)}
                  aria-label="Support Topic"
                  className="w-full px-3 py-2.5 rounded-xl border border-slate-700 bg-[#14223b] text-xs font-bold text-white"
                >
                  <option value="game_rules">
                    {lang === 'am' ? 'የጨዋታ ህጎች እና ካርዶች' : 'Game Rules & Cards'}
                  </option>
                  <option value="demo_wallet">
                    {lang === 'am' ? 'ቦርሳ እና ግብይቶች' : 'Wallet & Credits'}
                  </option>
                  <option value="technical">
                    {lang === 'am' ? 'የቴክኒክ እገዛ' : 'Technical Feedback'}
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  {lang === 'am' ? 'ርዕስ' : 'Subject'}
                </label>
                <input
                  type="text"
                  value={ticketSubject}
                  onChange={(e) => setTicketSubject(e.target.value)}
                  placeholder={lang === 'am' ? 'አጭር ርዕስ ይጻፉ...' : 'Brief summary...'}
                  aria-label="Support Subject"
                  className="w-full px-3 py-2.5 rounded-xl border border-slate-700 bg-[#14223b] text-xs font-bold text-white placeholder:text-slate-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1">
                  {lang === 'am' ? 'መልዕክት' : 'Message'}
                </label>
                <textarea
                  rows={3}
                  value={ticketMessage}
                  onChange={(e) => setTicketMessage(e.target.value)}
                  placeholder={
                    lang === 'am'
                      ? 'ጥያቄዎን ወይም አስተያየትዎን እዚህ ይጻፉ...'
                      : 'Describe your question or feedback...'
                  }
                  aria-label="Support Message"
                  className="w-full px-3 py-2.5 rounded-xl border border-slate-700 bg-[#14223b] text-xs font-medium text-white placeholder:text-slate-500"
                />
              </div>

              {ticketError && <p className="text-xs font-bold text-rose-400">{ticketError}</p>}

              <button
                type="submit"
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-cyan-400 to-sky-500 text-[#041421] text-xs font-extrabold flex items-center justify-center gap-1.5"
              >
                <Send size={14} />
                {lang === 'am' ? 'የድጋፍ ጥያቄ ላክ' : 'Submit Support Ticket'}
              </button>
            </form>

            {tickets.length > 0 && (
              <div className="pt-3 border-t border-slate-700/60 space-y-2">
                <small className="text-[10px] font-extrabold uppercase text-slate-400 block">
                  {lang === 'am' ? 'የእርስዎ የድጋፍ ጥያቄዎች' : 'YOUR SUPPORT TICKETS'} ({tickets.length})
                </small>
                {tickets.map((tkt) => (
                  <div
                    key={tkt.id}
                    className="p-3 rounded-xl bg-[#14223b] border border-slate-700/60 flex items-center justify-between text-xs"
                  >
                    <div>
                      <b className="text-white block">{tkt.subject}</b>
                      <small className="text-slate-400">
                        {tkt.id} · {tkt.createdAt}
                      </small>
                    </div>
                    <span className="font-bold text-cyan-300">
                      {tkt.status === 'answered'
                        ? lang === 'am'
                          ? 'ተመልሷል'
                          : 'Answered'
                        : lang === 'am'
                        ? 'ደርሷል'
                        : 'Received'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 4. TERMS & CONDITIONS SCREEN */}
      {mode === 'terms' && (
        <section className="bg-[#0f1a2e] border border-slate-700/60 rounded-2xl p-6 space-y-5 max-w-4xl">
          <div className="flex items-center gap-2 text-cyan-400">
            <ShieldCheck size={22} />
            <h2 className="font-['Outfit'] text-2xl font-extrabold text-white">
              {lang === 'am'
                ? 'ADEYBINGO — የጨዋታ ህጎች፣ ደንቦች እና የህግ ማሳሰቢያ'
                : 'ADEYBINGO — Game Rules, Terms & Compliance Notice'}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-300 leading-relaxed">
            <div className="p-4 rounded-2xl bg-[#14223b] border border-slate-700/60 space-y-2">
              <b className="text-sm font-extrabold text-cyan-300 block">
                {lang === 'am' ? '1. የጨዋታ ስርዓት እና Firebase ደህንነት' : '1. Game System & Firebase Security'}
              </b>
              <ul className="space-y-1 list-disc pl-4">
                <li>
                  {lang === 'am'
                    ? 'በእያንዳንዱ የጨዋታ ክፍል ከ 1 እስከ 600 የተቆጠሩ ካርዶች ይገኛሉ።'
                    : '1 to 600 unique deterministic cards per game room.'}
                </li>
                <li>
                  {lang === 'am'
                    ? 'አቶሚክ የFirestore ትራንዛክሽን በአንድ ተጫዋች ቢበዛ 4 ካርድ ብቻ ይፈቅዳል።'
                    : 'Atomic Firestore transactions enforce maximum 4 cards per player and prevent duplicate reservations.'}
                </li>
                <li>
                  {lang === 'am'
                    ? 'የስልክ ቁጥሮች በ /users/{uid}/private/contact ውስጥ ተለይተው ይጠበቃሉ።'
                    : 'Phone numbers are isolated in /users/{uid}/private/contact with owner-only access rules.'}
                </li>
                <li>
                  {lang === 'am'
                    ? 'የ60 ሰከንድ የሎቢ ቆጠራ እና ቢያንስ 3 ብቁ ተጫዋቾች ያስፈልጋሉ።'
                    : '60-second lobby countdown and minimum 3 eligible players.'}
                </li>
              </ul>
            </div>

            <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-400/25 space-y-2 text-amber-200">
              <b className="text-sm font-extrabold text-[#facc15] block">
                {lang === 'am'
                  ? '2. የህግ፣ የፈቃድ እና የሙከራ (Sandbox) ገደብ'
                  : '2. Regulatory & Sandbox Compliance Notice'}
              </b>
              <p>
                {lang === 'am'
                  ? 'ይህ የADEYBINGO እትም የሙከራ (Demo Sandbox) ነው። የኢትዮጵያ የህግ፣ የፈቃድ እና የክፍያ ተቋማት ማረጋገጫ እስኪጠናቀቅ ድረስ እውነተኛ ገንዘብ ማስገባት፣ ማውጣት ወይም የገንዘብ ሽልማት አይሰራም።'
                  : 'This release operates strictly in Demo Sandbox Mode. Real-money deposits, withdrawals, and cash prizes are disabled pending full legal, licensing, and payment-provider verification.'}
              </p>
              <p className="font-bold text-[#facc15]">
                {lang === 'am'
                  ? 'ዕድሜያቸው ከ18 ዓመት በላይ ለሆኑ ተሳታፊዎች ብቻ የተዘጋጀ።'
                  : '18+ Responsible Gaming & Fair Play Policy.'}
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
