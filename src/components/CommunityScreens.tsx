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
    <div className="space-y-2.5">
      {/* Sub-navigation bar ONLY for Profile, Referral, Support, and Terms */}
      {mode !== 'leaderboard' && (
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-1 bg-white border border-[#E7EDE8] rounded-xl p-1.5 shadow-[0_3px_10px_rgba(24,51,38,0.04)]">
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
                className={`px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold flex items-center justify-center sm:justify-start gap-1 transition-all min-h-[34px] ${
                  active
                    ? 'bg-gradient-to-r from-[#159447] to-[#08743A] text-white shadow-[0_2px_8px_rgba(21,148,71,0.2)]'
                    : 'text-[#68776D] hover:text-[#183326] hover:bg-[#FFF9ED]'
                }`}
              >
                <Icon size={13} />
                {lang === 'am' ? tab.am : tab.en}
              </button>
            );
          })}
        </div>
      )}

      {/* 0. LEADERBOARD & GAME HISTORY SCREEN */}
      {mode === 'leaderboard' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-start">
          <section className="lg:col-span-7 bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#F5BD42] to-[#D99B20] flex items-center justify-center text-[#183326] shadow-[0_3px_8px_rgba(245,189,66,0.25)]">
                  <Trophy size={18} />
                </div>
                <div>
                  <h2 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326]">
                    {copy.leaderboardTitle}
                  </h2>
                  <p className="text-[11px] text-[#68776D]">{copy.leaderboardSub}</p>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded-lg bg-[#E6F6EB] border border-[#159447]/30 text-[11px] font-extrabold text-[#08743A] tabular-nums">
                {leaderboard.length} {lang === 'am' ? 'ተጫዋቾች' : 'Players'}
              </span>
            </div>

            {leaderboard.length === 0 ? (
              <div
                data-testid="leaderboard-empty-state"
                className="p-4 rounded-xl bg-[#FFF9ED] border border-dashed border-[#159447]/30 text-center space-y-1.5"
              >
                <div className="w-9 h-9 rounded-xl bg-[#E6F6EB] mx-auto flex items-center justify-center text-[#159447]">
                  <Trophy size={18} />
                </div>
                <p className="text-xs font-extrabold text-[#183326]">
                  {copy.emptyLeaderboardTitle}
                </p>
                <p className="text-[11px] text-[#68776D] max-w-sm mx-auto">
                  {copy.emptyLeaderboardDesc}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {leaderboard.map((entry, idx) => {
                  const isGold = idx === 0;
                  const isSilver = idx === 1;
                  const isBronze = idx === 2;

                  const rankCardClasses = isGold
                    ? 'bg-gradient-to-r from-[#FEF5DC] via-[#FFF9ED] to-white border-2 border-[#F5BD42] shadow-[0_3px_10px_rgba(245,189,66,0.14)]'
                    : isSilver
                    ? 'bg-gradient-to-r from-slate-100 via-white to-white border border-slate-300'
                    : isBronze
                    ? 'bg-gradient-to-r from-amber-50 via-white to-white border border-amber-300'
                    : 'bg-[#FFF9ED]/70 border border-[#E7EDE8]';

                  const badgeClasses = isGold
                    ? 'bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326] border-[#D99B20]'
                    : isSilver
                    ? 'bg-gradient-to-br from-slate-200 to-slate-300 text-slate-800 border-slate-400'
                    : isBronze
                    ? 'bg-gradient-to-br from-amber-200 to-amber-400 text-amber-950 border-amber-500'
                    : 'bg-[#E6F6EB] text-[#08743A] border-[#159447]/25';

                  const medal = isGold ? '🥇' : isSilver ? '🥈' : isBronze ? '🥉' : `#${idx + 1}`;

                  return (
                    <div
                      key={entry.uid}
                      className={`p-2.5 rounded-xl flex items-center justify-between gap-2 transition-all ${rankCardClasses}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-8 h-8 rounded-lg border flex items-center justify-center text-xs font-extrabold shrink-0 shadow-2xs ${badgeClasses}`}
                        >
                          {medal}
                        </span>
                        <div className="min-w-0">
                          <b className="text-xs font-extrabold text-[#183326] block truncate">
                            {entry.displayName}
                          </b>
                          <small className="text-[10.5px] font-bold text-[#159447]">
                            {entry.wins} {lang === 'am' ? 'ድሎች' : 'verified wins'}
                          </small>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <b className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#08743A] tabular-nums block">
                          {entry.winningsEtb.toFixed(2)} ETB
                        </b>
                        {idx < 3 && (
                          <span className="text-[9.5px] font-extrabold text-[#9A6B0B]">
                            {idx === 0
                              ? lang === 'am'
                                ? '1ኛ ደረጃ'
                                : 'Top Champion'
                              : idx === 1
                              ? lang === 'am'
                                ? '2ኛ ደረጃ'
                                : '2nd Place'
                              : lang === 'am'
                              ? '3ኛ ደረጃ'
                              : '3rd Place'}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="lg:col-span-5 bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
            <div className="flex items-center justify-between">
              <h3 className="font-['Outfit'] text-base font-extrabold text-[#183326] flex items-center gap-1.5">
                <History size={16} className="text-[#159447]" />
                {lang === 'am' ? 'የእኔ የጨዋታ ታሪክ' : 'My Game History'}
              </h3>
              <span className="text-[11px] font-extrabold text-[#08743A] bg-[#E6F6EB] px-2 py-0.5 rounded-md tabular-nums">
                {gameHistory.length} {lang === 'am' ? 'ዙሮች' : 'rounds'}
              </span>
            </div>

            {gameHistory.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#FFF9ED] border border-dashed border-[#159447]/30 text-center space-y-1">
                <Sparkles size={18} className="mx-auto text-[#159447]" />
                <p className="text-xs font-extrabold text-[#183326]">
                  {lang === 'am' ? 'ምንም የጨዋታ ታሪክ የለም' : 'No game history yet'}
                </p>
                <p className="text-[10.5px] text-[#68776D]">
                  {lang === 'am'
                    ? 'ጨዋታ ሲያጠናቅቁ ውጤቶችዎ እዚህ ይቀመጣሉ።'
                    : 'Completed Bingo rounds will appear here automatically.'}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {gameHistory.map((item) => (
                  <div
                    key={item.id}
                    className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            item.outcome === 'won' ? 'bg-[#168A49]' : 'bg-[#68776D]'
                          }`}
                        />
                        <b className="text-xs font-extrabold text-[#183326] block truncate">
                          {lang === 'am' ? item.roomNameAm : item.roomNameEn}
                        </b>
                      </div>
                      <div className="text-[10.5px] text-[#68776D] mt-0.5 font-medium">
                        <span>{item.playedAt}</span>
                        {item.cardIds.length > 0 && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span className="text-[#08743A] font-bold">
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
                        className={`font-['Outfit'] text-xs sm:text-sm font-extrabold tabular-nums block ${
                          item.outcome === 'won' ? 'text-[#168A49]' : 'text-[#68776D]'
                        }`}
                      >
                        {item.outcome === 'won'
                          ? `+${item.prizeDemo.toFixed(2)} ETB`
                          : `${item.entryFeeDemo.toFixed(2)} ETB`}
                      </b>
                      <small className="text-[9.5px] font-bold text-[#68776D] tabular-nums">
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-start">
          <section className="lg:col-span-5 bg-gradient-to-br from-[#159447] to-[#08743A] border border-[#08743A] text-white rounded-xl p-3 sm:p-4 space-y-2.5 shadow-[0_6px_18px_rgba(21,148,71,0.18)]">
            <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider bg-[#F5BD42] text-[#183326] px-2.5 py-0.5 rounded-full">
              ✦ {lang === 'am' ? 'ይጋብዙ እና ያድጉ · +20 ብር ቦነስ' : 'INVITE & EARN · +20 ETB BONUS'}
            </span>
            <h2 className="font-['Outfit'] text-lg sm:text-xl font-extrabold leading-tight">
              {lang === 'am'
                ? 'ሲቀላቀሉ 15 ብር · ጓደኛ ሲጋብዙ +20 ብር ቦነስ!'
                : 'Get 15 Birr on Join & +20 Birr for Invited Friends!'}
            </h2>
            <p className="text-[11px] text-[#E6F6EB] leading-snug font-medium">
              {lang === 'am'
                ? 'እያንዳንዱ አዲስ ተጫዋች ሲቀላቀል 15 ብር ያገኛል፤ የተጋበዙ ጓደኞች ደግሞ +20 ብር ቦነስ ያገኛሉ። የግብዣ ሊንክዎን ለጓደኞችዎ ያጋሩ!'
                : 'Every player gets 15 Birr when they join, and invited friends earn you a +20 Birr reward bonus! Share your personal invite code below.'}
            </p>

            <div className="bg-white text-[#183326] p-2.5 sm:p-3 rounded-xl space-y-1.5 shadow-sm">
              <small className="text-[9.5px] uppercase tracking-wider text-[#159447] block font-extrabold">
                {lang === 'am' ? 'የእርስዎ የግብዣ ሊንክ' : 'YOUR PERSONAL INVITE LINK'}
              </small>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 text-[11px] font-mono truncate bg-[#FFF9ED] text-[#183326] px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] font-bold">
                  {inviteLink}
                </code>
                <button
                  type="button"
                  onClick={handleCopyInvite}
                  className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-[#F5BD42] to-[#D99B20] text-[#183326] text-xs font-extrabold flex items-center gap-1 shrink-0 min-h-[34px] shadow-2xs hover:brightness-105"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied
                    ? lang === 'am'
                      ? 'ተቀድቷል'
                      : 'Copied'
                    : lang === 'am'
                    ? 'ቅዳ'
                    : 'Copy'}
                </button>
              </div>
              <div className="text-[11px] font-mono text-[#68776D] flex items-center justify-between pt-0.5">
                <span>
                  {lang === 'am' ? 'የእርስዎ ኮድ፦' : 'Your code:'}{' '}
                  <b className="text-[#08743A]">{effectiveRefCode}</b>
                </span>
                <span className="text-[9.5px] font-extrabold bg-[#E6F6EB] text-[#08743A] px-1.5 py-0.5 rounded">
                  +20 ETB / {lang === 'am' ? 'ጓደኛ' : 'Friend'}
                </span>
              </div>
            </div>

            {onApplyPromoCode && (
              <form
                onSubmit={handleApplyReferralSubmit}
                className="bg-white/95 text-[#183326] rounded-xl p-2.5 sm:p-3 space-y-1.5 shadow-2xs"
              >
                <small className="text-[11px] font-extrabold text-[#08743A] flex items-center gap-1">
                  <TicketPercent size={13} className="text-[#D99B20]" />
                  {copy.promoSectionTitle}
                </small>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={promoCodeInput}
                    onChange={(e) => setPromoCodeInput(e.target.value)}
                    placeholder={copy.promoPlaceholder}
                    aria-label={copy.promoSectionTitle}
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326] text-xs font-mono font-bold placeholder:text-[#68776D] min-h-[34px] focus:outline-none focus:border-[#159447]"
                  />
                  <button
                    type="submit"
                    disabled={promoBusy || !promoCodeInput.trim()}
                    className="px-3 py-1.5 rounded-lg bg-[#159447] text-white text-xs font-extrabold shrink-0 min-h-[34px] disabled:opacity-50"
                  >
                    {promoBusy ? '...' : copy.applyPromoBtn}
                  </button>
                </div>
                {promoFeedback && (
                  <p
                    className={`text-[11px] font-bold ${
                      promoFeedback.ok ? 'text-[#168A49]' : 'text-[#D94B4B]'
                    }`}
                  >
                    {promoFeedback.text}
                  </p>
                )}
              </form>
            )}
          </section>

          <section className="lg:col-span-7 bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
            <div className="flex items-center justify-between">
              <h3 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326]">
                {lang === 'am'
                  ? `የተጋበዙ ጓደኞች (${referrals.length})`
                  : `Invited Friends (${referrals.length})`}
              </h3>
              <span className="text-[11px] font-extrabold bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42] px-2.5 py-0.5 rounded-lg tabular-nums">
                +
                {referrals
                  .filter((r) => r.status === 'qualified')
                  .reduce((sum, r) => sum + r.inviterBonus, 0)}{' '}
                ETB
              </span>
            </div>

            {referrals.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#FFF9ED] border border-dashed border-[#159447]/30 text-center space-y-1">
                <Gift size={20} className="mx-auto text-[#D99B20]" />
                <p className="text-xs font-extrabold text-[#183326]">
                  {lang === 'am' ? 'እስካሁን የተጋበዙ ጓደኞች የሉም' : 'No referred friends yet'}
                </p>
                <p className="text-[11px] text-[#68776D]">
                  {lang === 'am'
                    ? 'ሊንክዎን ሲያጋሩ እና ጓደኛዎ ሲቀላቀል እዚህ ይታያል።'
                    : 'Share your personal link to track verified friend referrals and bonus rewards here.'}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {referrals.map((ref) => (
                  <div
                    key={ref.id}
                    className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-8 h-8 rounded-full bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] font-extrabold text-[11px] flex items-center justify-center">
                        {ref.friendName.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <b className="text-xs font-extrabold text-[#183326] block">
                          {ref.friendName}{' '}
                          <span className="font-normal text-[#68776D]">{ref.handle}</span>
                        </b>
                        <small className="text-[10.5px] text-[#68776D]">{ref.joinedAt}</small>
                      </div>
                    </div>

                    <div className="text-right">
                      <b className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#D99B20] tabular-nums block">
                        +{ref.inviterBonus} ETB
                      </b>
                      <small className="text-[10px] font-bold text-[#168A49]">
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

      {/* 2. PROFILE, FIREBASE AUTH & PII PHONE VERIFICATION */}
      {mode === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-start">
          <section className="lg:col-span-6 space-y-2.5 min-w-0">
            {/* Friendly Player Identity Card */}
            <div className="bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
              <div className="flex items-center gap-2.5">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#159447] to-[#08743A] text-white font-['Outfit'] text-lg font-extrabold flex items-center justify-center shadow-[0_3px_10px_rgba(21,148,71,0.22)] border-2 border-[#F5BD42] shrink-0">
                  {user.initials}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-[9.5px] font-extrabold uppercase text-[#159447] block truncate">
                    {firebaseUid
                      ? 'TELEGRAM MINI APP · CLOUD SYNC ACTIVE'
                      : 'TELEGRAM MINI APP · SESSION'}
                  </span>
                  <h2 className="font-['Outfit'] text-lg font-extrabold text-[#183326] truncate">
                    {user.firstName} {user.lastName}
                  </h2>
                  <p className="text-[11px] text-[#68776D] font-mono truncate">
                    {user.username} · TG #{user.id}
                  </p>
                  {firebaseUserEmail && (
                    <p className="text-[10.5px] text-[#168A49] font-extrabold truncate mt-0.5">
                      ✓ {firebaseUserEmail}
                    </p>
                  )}
                </div>
              </div>

              {/* Telegram Mini App Server Auth / Sign-Out Action */}
              <div className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-bold text-[#183326] flex items-center gap-1">
                    <Database size={12} className="text-[#159447]" />
                    {lang === 'am' ? 'Cloud Firestore ግንኙነት' : 'Cloud Firestore Status'}
                  </span>
                  <span className="font-mono text-[10px] font-extrabold text-[#08743A] bg-[#E6F6EB] px-1.5 py-0.5 rounded">
                    {firestoreConnected ? 'CONNECTED' : 'CHECKING'}
                  </span>
                </div>

                {firebaseUid ? (
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <span className="text-[10.5px] font-mono text-[#68776D] truncate">
                      UID: {firebaseUid.slice(0, 14)}...
                    </span>
                    <button
                      type="button"
                      onClick={onSignOutFirebase}
                      className="px-2.5 py-1 rounded-lg border border-[#E7EDE8] bg-white text-[#183326] text-[11px] font-extrabold flex items-center gap-1 hover:border-[#159447]/40 hover:bg-[#E6F6EB] min-h-[30px]"
                    >
                      <LogOut size={12} />
                      {lang === 'am' ? 'ውጣ' : 'Disconnect'}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={onSignInGoogle}
                    className="w-full py-1.5 px-3 rounded-lg bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-xs font-extrabold flex items-center justify-center gap-1.5 shadow-2xs hover:brightness-105 min-h-[34px]"
                  >
                    <LogIn size={13} />
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
              className="bg-white border border-[#159447]/35 rounded-xl p-3 sm:p-3.5 space-y-2 shadow-[0_3px_10px_rgba(24,51,38,0.05)]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[9.5px] font-extrabold uppercase text-[#159447] flex items-center gap-1">
                    <ShieldCheck size={11} />
                    {lang === 'am'
                      ? 'በሰርቨር የተረጋገጠ (SERVER-VERIFIED INITDATA)'
                      : 'SERVER-VERIFIED INITDATA'}
                  </span>
                  <h3 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326]">
                    {lang === 'am' ? 'የእኔ የቴሌግራም መለያ (My Telegram ID)' : 'My Telegram ID'}
                  </h3>
                </div>
                <span
                  className={`text-[10px] font-extrabold px-2 py-0.5 rounded-md shrink-0 ${
                    serverVerifiedTelegramId !== null
                      ? 'bg-[#E6F6EB] text-[#08743A] border border-[#159447]/30'
                      : 'bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42]'
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

              <p className="text-[11px] text-[#68776D] leading-snug">
                {lang === 'am'
                  ? 'ይህ ቁጥር የሚገኘው ከቴሌግራም Mini App የተፈረመ initData በሰርቨር ላይ ከተረጋገጠ በኋላ ብቻ ነው።'
                  : 'Retrieved exclusively from cryptographically verified Telegram Mini App initData on the server.'}
              </p>

              <div className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8]">
                <div className="min-w-0">
                  <span className="text-[9.5px] font-bold uppercase text-[#68776D] block">
                    {lang === 'am' ? 'የተረጋገጠ የቴሌግራም ቁጥር' : 'Verified Numeric Telegram ID'}
                  </span>
                  <code
                    data-testid="verified-telegram-id-value"
                    className="font-mono text-xs sm:text-sm font-extrabold text-[#183326] select-all block truncate"
                  >
                    {serverVerifiedTelegramId !== null
                      ? String(serverVerifiedTelegramId)
                      : lang === 'am'
                      ? 'በቴሌግራም Mini App ውስጥ ሲከፍቱ ይታያል'
                      : 'Open in Telegram Mini App to verify'}
                  </code>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    data-testid="copy-telegram-id-btn"
                    disabled={serverVerifiedTelegramId === null}
                    onClick={handleCopyTelegramId}
                    className={`px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold flex items-center gap-1 transition-colors min-h-[32px] ${
                      serverVerifiedTelegramId !== null
                        ? 'bg-[#159447] text-white hover:bg-[#08743A] cursor-pointer'
                        : 'bg-[#E7EDE8] text-[#68776D] cursor-not-allowed'
                    }`}
                  >
                    {copiedTelegramId ? <Check size={12} /> : <Copy size={12} />}
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

          <section className="lg:col-span-6 space-y-2.5 min-w-0">
            {/* Secure Phone Number Registration & Verification (PII-Isolated Subcollection) */}
            <form
              onSubmit={handlePhoneSubmit}
              className="bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[9.5px] font-extrabold uppercase text-[#159447] flex items-center gap-1">
                    <Lock size={11} />
                    {lang === 'am' ? 'የግል መረጃ ጥበቃ (PII ISOLATED)' : 'PII-ISOLATED SUBCOLLECTION'}
                  </span>
                  <h3 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326]">
                    {lang === 'am' ? 'የስልክ ቁጥር ምዝገባ እና ማረጋገጫ' : 'Phone Registration & Verification'}
                  </h3>
                </div>
                <span
                  className={`text-[10px] font-extrabold px-2 py-0.5 rounded-md shrink-0 ${
                    phoneVerified
                      ? 'bg-[#E6F6EB] text-[#08743A] border border-[#159447]/30'
                      : 'bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42]'
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

              <p className="text-[11px] text-[#68776D] leading-snug break-words">
                {lang === 'am'
                  ? 'ስልክ ቁጥርዎ በ /users/{uid}/private/contact ውስጥ በጥብቅ ደህንነት ይቀመጣል።'
                  : 'Stored strictly in /users/{uid}/private/contact — inaccessible to other players.'}
              </p>

              <div>
                <label className="block text-[11px] font-bold text-[#183326] mb-1">
                  {lang === 'am' ? 'የማረጋገጫ ዘዴ' : 'Verification Method'}
                </label>
                <select
                  value={phoneMethod}
                  onChange={(e) =>
                    setPhoneMethod(e.target.value as 'telegram_contact' | 'sms_otp_demo')
                  }
                  aria-label="Phone Verification Method"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] min-h-[34px] focus:outline-none focus:border-[#159447]"
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
                <label className="block text-[11px] font-bold text-[#183326] mb-1">
                  {lang === 'am' ? 'የስልክ ቁጥር' : 'Phone Number'}
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="tel"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="+251911223344"
                    aria-label="Phone Number for Verification"
                    className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-mono font-bold text-[#183326] min-h-[34px] focus:outline-none focus:border-[#159447]"
                  />
                  <button
                    type="submit"
                    disabled={phoneBusy}
                    className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-xs font-extrabold flex items-center gap-1 shrink-0 min-h-[34px]"
                  >
                    <Phone size={12} />
                    {phoneBusy ? '...' : lang === 'am' ? 'አረጋግጥ' : 'Verify'}
                  </button>
                </div>
              </div>

              {phoneError && <p className="text-[11px] font-bold text-[#D94B4B]">{phoneError}</p>}
            </form>

            {/* Motion Accessibility & Collapsible Telegram Bot Diagnostics */}
            <div className="bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8]">
                <div>
                  <span className="text-xs font-extrabold text-[#183326] block">
                    {lang === 'am' ? 'እንቅስቃሴ ቀንስ (Reduced Motion)' : 'Reduced Motion Mode'}
                  </span>
                  <small className="text-[10.5px] text-[#68776D]">
                    {lang === 'am'
                      ? 'የ3D ኳስ እና የድል አኒሜሽን ያቃልላል'
                      : 'Simplifies 3D ball & celebration animations'}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={onToggleReducedMotion}
                  className={`px-3 py-1 rounded-lg text-xs font-extrabold min-h-[32px] border ${
                    reducedMotion
                      ? 'bg-[#159447] border-[#08743A] text-white'
                      : 'bg-white text-[#68776D] border-[#E7EDE8]'
                  }`}
                >
                  {reducedMotion ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="rounded-lg border border-[#E7EDE8] overflow-hidden bg-[#FFF9ED]/60">
                <button
                  type="button"
                  onClick={() => setShowAdvancedBot((prev) => !prev)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs font-extrabold text-[#183326] hover:bg-[#E6F6EB]/50 min-h-[36px]"
                >
                  <span>
                    {lang === 'am'
                      ? 'የቴሌግራም ቦት እና የቴክኒክ ምርመራ'
                      : 'Telegram Bot & Diagnostics'}
                  </span>
                  {showAdvancedBot ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>

                {showAdvancedBot && (
                  <div className="p-2.5 pt-1.5 space-y-2.5 border-t border-[#E7EDE8]">
                    <div className="p-2.5 rounded-lg bg-white border border-[#E7EDE8] space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-extrabold text-[#183326]">
                          {lang === 'am'
                            ? 'የቴሌግራም initData የሰርቨር ማረጋገጫ'
                            : 'Telegram initData Backend Check'}
                        </span>
                        <button
                          type="button"
                          onClick={onValidateTelegramInitData}
                          className="px-2.5 py-1 rounded-lg bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] text-[10.5px] font-extrabold hover:bg-[#159447] hover:text-white transition-colors shrink-0"
                        >
                          {lang === 'am' ? 'አሁን ፈትሽ' : 'Verify on Server'}
                        </button>
                      </div>
                      <p className="text-[10.5px] text-[#68776D] font-mono leading-snug break-words">
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-start">
          <section className="lg:col-span-6 bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
            <h3 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326]">
              {lang === 'am' ? 'ተደጋጋሚ ጥያቄዎች (FAQ)' : 'Frequently Asked Questions'}
            </h3>
            <div className="space-y-2">
              {FAQ_ITEMS.map((faq, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] space-y-1"
                >
                  <b className="text-xs font-extrabold text-[#159447] block">
                    {lang === 'am' ? faq.qAm : faq.qEn}
                  </b>
                  <p className="text-[11px] text-[#68776D] leading-snug">
                    {lang === 'am' ? faq.aAm : faq.aEn}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="lg:col-span-6 bg-white border border-[#E7EDE8] rounded-xl p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
            <h3 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326]">
              {lang === 'am' ? 'የድጋፍ መልዕክት ይላኩ' : 'Contact Player Support'}
            </h3>

            <form onSubmit={handleSupportSubmit} className="space-y-2">
              <div>
                <label className="block text-[11px] font-bold text-[#183326] mb-1">
                  {lang === 'am' ? 'ምድብ' : 'Topic'}
                </label>
                <select
                  value={ticketCategory}
                  onChange={(e) => setTicketCategory(e.target.value)}
                  aria-label="Support Topic"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] min-h-[34px] focus:outline-none focus:border-[#159447]"
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
                <label className="block text-[11px] font-bold text-[#183326] mb-1">
                  {lang === 'am' ? 'ርዕስ' : 'Subject'}
                </label>
                <input
                  type="text"
                  value={ticketSubject}
                  onChange={(e) => setTicketSubject(e.target.value)}
                  placeholder={lang === 'am' ? 'አጭር ርዕስ ይጻፉ...' : 'Brief summary...'}
                  aria-label="Support Subject"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] placeholder:text-[#68776D] min-h-[34px] focus:outline-none focus:border-[#159447]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[#183326] mb-1">
                  {lang === 'am' ? 'መልዕክት' : 'Message'}
                </label>
                <textarea
                  rows={2}
                  value={ticketMessage}
                  onChange={(e) => setTicketMessage(e.target.value)}
                  placeholder={
                    lang === 'am'
                      ? 'ጥያቄዎን ወይም አስተያየትዎን እዚህ ይጻፉ...'
                      : 'Describe your question or feedback...'
                  }
                  aria-label="Support Message"
                  className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-medium text-[#183326] placeholder:text-[#68776D] focus:outline-none focus:border-[#159447]"
                />
              </div>

              {ticketError && <p className="text-[11px] font-bold text-[#D94B4B]">{ticketError}</p>}

              <button
                type="submit"
                className="w-full py-2 px-3 rounded-lg bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-xs font-extrabold flex items-center justify-center gap-1.5 min-h-[36px] shadow-[0_3px_10px_rgba(21,148,71,0.2)]"
              >
                <Send size={13} />
                {lang === 'am' ? 'የድጋፍ ጥያቄ ላክ' : 'Submit Support Ticket'}
              </button>
            </form>

            {tickets.length > 0 && (
              <div className="pt-2 border-t border-[#E7EDE8] space-y-1.5">
                <small className="text-[9.5px] font-extrabold uppercase text-[#68776D] block">
                  {lang === 'am' ? 'የእርስዎ የድጋፍ ጥያቄዎች' : 'YOUR SUPPORT TICKETS'} ({tickets.length})
                </small>
                {tickets.map((tkt) => (
                  <div
                    key={tkt.id}
                    className="p-2.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] flex items-center justify-between text-xs"
                  >
                    <div>
                      <b className="text-[#183326] block">{tkt.subject}</b>
                      <small className="text-[#68776D]">
                        {tkt.id} · {tkt.createdAt}
                      </small>
                    </div>
                    <span className="font-extrabold text-[#159447] bg-[#E6F6EB] px-2 py-0.5 rounded-md text-[10.5px]">
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
        <section className="bg-white border border-[#E7EDE8] rounded-xl p-3.5 sm:p-4 space-y-3 max-w-4xl shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
          <div className="flex items-center gap-2 text-[#159447]">
            <ShieldCheck size={20} />
            <h2 className="font-['Outfit'] text-lg sm:text-xl font-extrabold text-[#183326]">
              {lang === 'am'
                ? 'ADEYBINGO — የጨዋታ ህጎች፣ ደንቦች እና የህግ ማሳሰቢያ'
                : 'ADEYBINGO — Game Rules, Terms & Compliance Notice'}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-[11px] text-[#68776D] leading-snug">
            <div className="p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] space-y-1.5">
              <b className="text-xs font-extrabold text-[#159447] block">
                {lang === 'am' ? '1. የጨዋታ ስርዓት እና Firebase ደህንነት' : '1. Game System & Firebase Security'}
              </b>
              <ul className="space-y-1 list-disc pl-4 text-[#183326]">
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

            <div className="p-3 rounded-xl bg-[#FEF5DC]/75 border border-[#F5BD42] space-y-1.5 text-[#183326]">
              <b className="text-xs font-extrabold text-[#9A6B0B] block">
                {lang === 'am'
                  ? '2. የህግ፣ የፈቃድ እና የሙከራ (Sandbox) ገደብ'
                  : '2. Regulatory & Sandbox Compliance Notice'}
              </b>
              <p>
                {lang === 'am'
                  ? 'ይህ የADEYBINGO እትም የሙከራ (Demo Sandbox) ነው። የኢትዮጵያ የህግ፣ የፈቃድ እና የክፍያ ተቋማት ማረጋገጫ እስኪጠናቀቅ ድረስ እውነተኛ ገንዘብ ማስገባት፣ ማውጣት ወይም የገንዘብ ሽልማት አይሰራም።'
                  : 'This release operates strictly in Demo Sandbox Mode. Real-money deposits, withdrawals, and cash prizes are disabled pending full legal, licensing, and payment-provider verification.'}
              </p>
              <p className="font-extrabold text-[#08743A]">
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
