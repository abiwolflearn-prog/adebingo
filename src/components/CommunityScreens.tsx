import { useEffect, useState } from 'react';
import {
  Gift,
  Copy,
  Check,
  User,
  Headphones,
  FileText,
  Send,
  ShieldCheck,
  Phone,
  LogIn,
  LogOut,
  Database,
  Lock,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  ExternalLink,
} from 'lucide-react';
import {
  Language,
  ReferralRecord,
  ScreenId,
  SupportTicket,
} from '../types/bingo';
import { t } from '../utils/i18n';
import {
  buildTelegramInviteLink,
  buildTelegramReferralCode,
  buildTelegramShareUrl,
  openTelegramShareLink,
  requestTelegramContact,
  TelegramUserProfile,
} from '../utils/telegram';
import { TelegramBotConsole } from './TelegramBotConsole';

interface CommunityScreensProps {
  mode: 'referral' | 'profile' | 'support' | 'terms';
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
  referredByCode?: string;
  referrals: ReferralRecord[];
  onApplyPromoCode?: (code: string) => Promise<{ ok: boolean; message: string }>;
  tickets: SupportTicket[];
  onSubmitSupportTicket: (category: string, subject: string, message: string) => void;
  reducedMotion: boolean;
  onToggleReducedMotion: () => void;
  onNavigate: (screen: ScreenId) => void;
}

const FAQ_ITEMS = [
  {
    qAm: '1–600 ካርዶች እንዴት ይሰራሉ?',
    qEn: 'How do 1–600 Bingo cards work?',
    aAm: 'በአንድ ክፍል ከ #1 እስከ #600 ልዩ 5x5 ካርዶች አሉ። በአንድ ዙር እስከ 4 ካርድ መምረጥ ይችላሉ።',
    aEn: '600 unique 5x5 Bingo cards (#1–#600) per room. Pick up to 4 cards per round.',
  },
  {
    qAm: 'የካርድ ምርጫ ደህንነት እንዴት ይጠበቃል?',
    qEn: 'How are card reservations protected?',
    aAm: 'በአቶሚክ Firestore ትራንዛክሽን (runTransaction) ስለሚመዘገብ አንድ ካርድ በሁለት ተጫዋቾች አይያዝም።',
    aEn: 'Atomic Firestore transactions prevent duplicate card reservations and enforce the 4-card limit.',
  },
  {
    qAm: 'የስልክ ቁጥሬ ደህንነት እንዴት ይጠበቃል?',
    qEn: 'How is my phone number protected?',
    aAm: 'በ /users/{uid}/private/contact ውስጥ ተለይቶ ይቀመጣል፤ ከእርስዎ በስተቀር ማንም አያየውም።',
    aEn: 'Isolated in /users/{uid}/private/contact readable only by your authenticated UID.',
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
  referredByCode,
  referrals,
  tickets,
  onSubmitSupportTicket,
  reducedMotion,
  onToggleReducedMotion,
  onNavigate,
}: CommunityScreensProps) {
  const copy = t(lang);
  const [copied, setCopied] = useState(false);
  const [copiedTelegramId, setCopiedTelegramId] = useState(false);

  const [phoneInput, setPhoneInput] = useState(phoneNumber || '');
  const [phoneError, setPhoneError] = useState('');
  const [phoneBusy, setPhoneBusy] = useState(false);

  useEffect(() => {
    if (phoneNumber) {
      setPhoneInput(phoneNumber);
    }
  }, [phoneNumber]);

  const [ticketCategory, setTicketCategory] = useState('game_rules');
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketMessage, setTicketMessage] = useState('');
  const [ticketError, setTicketError] = useState('');
  const [showAdvancedBot, setShowAdvancedBot] = useState(false);

  const fallbackRefCode =
    Number.isInteger(user.id) && user.id > 0 ? buildTelegramReferralCode(user.id) : '';
  const effectiveRefCode =
    serverVerifiedTelegramId && Number.isInteger(serverVerifiedTelegramId) && serverVerifiedTelegramId > 0
      ? buildTelegramReferralCode(serverVerifiedTelegramId)
      : referralCode || fallbackRefCode;
  const inviteLink = effectiveRefCode
    ? buildTelegramInviteLink(effectiveRefCode)
    : 'https://t.me/AdeyBingoGameBot';
  const shareInviteText =
    lang === 'am'
      ? '🌼 ADEYBINGO ይቀላቀሉ! በ60 ሰከንድ ዙር ቢንጎ ይጫወቱ እና በ15 ETB መነሻ ሂሳብ ይጀምሩ!'
      : '🌼 Join ADEYBINGO! Play live 60-second Bingo rounds and start with 15 ETB starter balance!';
  const telegramShareUrl = buildTelegramShareUrl(inviteLink, shareInviteText);

  const copyTextSafely = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {
      // Fallback below
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

  const handleNativeTelegramContact = async () => {
    setPhoneError('');
    setPhoneBusy(true);
    try {
      const result = await requestTelegramContact();
      if (result.supported && result.sent) {
        setPhoneError(
          lang === 'am'
            ? 'የቴሌግራም ስልክ ቁጥርዎ ተልኳል — በጥቂት ሰከንዶች ውስጥ ይረጋገጣል።'
            : 'Telegram contact shared — verification will sync automatically in a few seconds.'
        );
        await onVerifyPhone('', 'telegram_contact');
      } else if (result.supported && !result.sent) {
        setPhoneError(
          lang === 'am'
            ? 'የስልክ ቁጥር ማጋራቱ ተሰርዟል። ስልክዎን ለማረጋገጥ በፈለጉት ጊዜ እንደገና መሞከር ይችላሉ።'
            : 'Contact sharing was cancelled. You can tap the button again anytime to verify your phone.'
        );
      } else {
        setPhoneError(
          lang === 'am'
            ? '🔒 ስልክ ቁጥር የሚረጋገጠው በቴሌግራም ቀጥተኛ የስልክ ማጋራት ብቻ ነው። እባክዎ @AdeyBingoGameBot በመክፈት "📲 ስልክ ቁጥርዎን ያጋሩ" የሚለውን ቁልፍ ይጫኑ።'
            : '🔒 Phone verification requires native Telegram contact sharing. Open @AdeyBingoGameBot and tap "📲 Share Telegram Phone Contact".'
        );
      }
    } finally {
      setPhoneBusy(false);
    }
  };

  const handlePhoneSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPhoneError(
      lang === 'am'
        ? '🔒 በጽሁፍ የተጻፈ ስልክ ቁጥር አይረጋገጥም። እባክዎ "በቴሌግራም ስልክ አጋራ" ቁልፍን ወይም በ@AdeyBingoGameBot ውስጥ "📲 ስልክ ቁጥርዎን ያጋሩ" ይጫኑ።'
        : '🔒 Manually typed phone numbers are never marked as verified. Please tap "Share Telegram Contact" or use "📲 Share Telegram Phone Contact" in @AdeyBingoGameBot.'
    );
  };

  const handleSupportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (ticketSubject.trim().length < 3 || ticketMessage.trim().length < 6) {
      setTicketError(
        lang === 'am'
          ? 'ርዕስ እና መልዕክትዎን በትክክል ይጻፉ።'
          : 'Please enter both a subject and message.'
      );
      return;
    }
    setTicketError('');
    onSubmitSupportTicket(ticketCategory, ticketSubject.trim(), ticketMessage.trim());
    setTicketSubject('');
    setTicketMessage('');
  };

  return (
    <div className="space-y-2">
      {/* Compact Icon-First Sub-Navigation Bar for Profile, Referral, Support, and Terms */}
      <div className="grid grid-cols-4 items-center gap-1 bg-white border border-[#E7EDE8] rounded-xl p-1 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
        {(
          [
            { id: 'profile', icon: User, am: 'መገለጫ', en: 'Profile' },
            { id: 'referral', icon: Gift, am: 'ግብዣ +20', en: 'Invite +20' },
            { id: 'support', icon: Headphones, am: 'እገዛ', en: 'Help' },
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
              title={lang === 'am' ? tab.am : tab.en}
              className={`px-2 py-1.5 rounded-lg text-[10.5px] font-extrabold flex items-center justify-center gap-1 transition-all min-h-[32px] whitespace-nowrap ${
                active
                  ? 'bg-gradient-to-r from-[#159447] to-[#08743A] text-white shadow-[0_2px_6px_rgba(21,148,71,0.2)]'
                  : 'text-[#68776D] hover:text-[#183326] hover:bg-[#FFF9ED]'
              }`}
            >
              <Icon size={13} className="shrink-0" />
              <span className="truncate">{lang === 'am' ? tab.am : tab.en}</span>
            </button>
          );
        })}
      </div>

      {/* 1. REFERRAL SYSTEM SCREEN (Compact & Icon-First) */}
      {mode === 'referral' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-start">
          <section className="lg:col-span-5 bg-gradient-to-br from-[#159447] to-[#08743A] border border-[#08743A] text-white rounded-xl p-2.5 sm:p-3 space-y-2 shadow-[0_4px_14px_rgba(21,148,71,0.16)]">
            <div className="flex items-center justify-between gap-1.5">
              <span className="inline-flex items-center gap-1 text-[9.5px] font-extrabold uppercase tracking-wider bg-[#F5BD42] text-[#183326] px-2 py-0.5 rounded-full">
                <Gift size={10} />
                {lang === 'am' ? '+20 ብር ግብዣ' : '+20 ETB INVITE'}
              </span>
              <span className="text-[10px] font-extrabold text-[#E6F6EB]">
                15 ETB {lang === 'am' ? 'መነሻ' : 'Start'}
              </span>
            </div>

            <div className="bg-white text-[#183326] p-2 sm:p-2.5 rounded-xl space-y-1.5 shadow-xs">
              <div className="flex items-center justify-between text-[10px] font-extrabold text-[#159447]">
                <span>{lang === 'am' ? 'የግብዣ ሊንክ' : 'INVITE LINK'}</span>
                <b className="font-mono text-[#08743A]">{effectiveRefCode}</b>
              </div>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 text-[10.5px] font-mono truncate bg-[#FFF9ED] text-[#183326] px-2 py-1.5 rounded-lg border border-[#E7EDE8] font-bold">
                  {inviteLink}
                </code>
                <button
                  type="button"
                  onClick={handleCopyInvite}
                  title={lang === 'am' ? 'የግብዣ ሊንክ ቅዳ' : 'Copy invite link'}
                  className="px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-[#F5BD42] to-[#D99B20] text-[#183326] text-[11px] font-extrabold flex items-center gap-1 shrink-0 min-h-[32px] shadow-2xs hover:brightness-105"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied
                    ? lang === 'am'
                      ? 'ተቀድቷል'
                      : 'Copied'
                    : lang === 'am'
                    ? 'ቅዳ'
                    : 'Copy'}
                </button>
              </div>
              <a
                href={telegramShareUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (openTelegramShareLink(telegramShareUrl)) {
                    e.preventDefault();
                  }
                }}
                className="w-full py-2 px-3 rounded-lg bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-[11.5px] font-extrabold flex items-center justify-center gap-1.5 shadow-2xs hover:brightness-105"
              >
                <Send size={13} />
                {lang === 'am'
                  ? 'በቴሌግራም ለጓደኛ ላክ (+20 ብር)'
                  : 'Share in Telegram (+20 ETB)'}
              </a>
            </div>

            <div className="bg-white/95 text-[#183326] rounded-xl p-2 sm:p-2.5 space-y-1 shadow-2xs text-[10.5px]">
              <p className="font-extrabold text-[#08743A] flex items-center gap-1">
                <ShieldCheck size={12} className="text-[#159447]" />
                {lang === 'am' ? 'የግብዣ ሽልማት ህግ' : 'How Referral Rewards Work'}
              </p>
              <p className="text-[#4B5E52] leading-snug">
                {lang === 'am'
                  ? 'አዲስ ጓደኛ በግብዣ ሊንክዎ ሲመዘገብ ለእርስዎ +20 ETB ቦነስ ወዲያውኑ ይጨመራል። አዲስ ተጫዋች መደበኛ 15 ETB መነሻ ሂሳብ ያገኛል (ተጨማሪ 0 ETB)።'
                  : 'You earn +20 ETB immediately when a brand-new player registers through your Telegram invite link. New accounts receive the standard 15 ETB starter balance (0 ETB extra invitee bonus).'}
              </p>
              {referredByCode ? (
                <p className="font-bold text-[#08743A] pt-0.5">
                  {lang === 'am'
                    ? `የተጋበዙበት ኮድ፦ ${referredByCode}`
                    : `Invited via referral code: ${referredByCode}`}
                </p>
              ) : (
                <p className="text-[10px] text-[#68776D] pt-0.5">
                  {lang === 'am'
                    ? 'የግብዣ ሊንኮች በመጀመሪያ ምዝገባ ጊዜ ብቻ በራስ-ሰር ይመዘገባሉ።'
                    : 'Referrals are attributed automatically on first-time signup only.'}
                </p>
              )}
            </div>
          </section>

          <section className="lg:col-span-7 bg-white border border-[#E7EDE8] rounded-xl p-2.5 sm:p-3 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
            <div className="flex items-center justify-between">
              <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] flex items-center gap-1.5">
                <Gift size={14} className="text-[#D99B20]" />
                {lang === 'am'
                  ? `የተጋበዙ (${referrals.length})`
                  : `Invited (${referrals.length})`}
              </h3>
              <span className="text-[10.5px] font-extrabold bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42] px-2 py-0.5 rounded-lg tabular-nums">
                +
                {referrals
                  .filter((r) => r.status === 'qualified')
                  .reduce((sum, r) => sum + r.inviterBonus, 0)}{' '}
                ETB
              </span>
            </div>

            {referrals.length === 0 ? (
              <div className="p-3.5 rounded-xl bg-[#FFF9ED] border border-dashed border-[#159447]/30 text-center space-y-1">
                <Gift size={18} className="mx-auto text-[#D99B20]" />
                <p className="text-xs font-extrabold text-[#183326]">
                  {lang === 'am' ? 'የተጋበዙ ጓደኞች የሉም' : 'No referred friends yet'}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {referrals.map((ref) => (
                  <div
                    key={ref.id}
                    className="p-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-7 h-7 rounded-full bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] font-extrabold text-[10px] flex items-center justify-center">
                        {ref.friendName.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <b className="text-[11px] font-extrabold text-[#183326] block">
                          {ref.friendName}{' '}
                          <span className="font-normal text-[#68776D]">{ref.handle}</span>
                        </b>
                        <small className="text-[9.5px] text-[#68776D]">{ref.joinedAt}</small>
                      </div>
                    </div>

                    <div className="text-right">
                      <b className="font-['Outfit'] text-xs font-extrabold text-[#D99B20] tabular-nums block">
                        +{ref.inviterBonus} ETB
                      </b>
                      <small className="text-[9.5px] font-bold text-[#168A49]">
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

      {/* 2. PROFILE, FIREBASE AUTH & PII PHONE VERIFICATION (Compact & Icon-First) */}
      {mode === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-start">
          <section className="lg:col-span-6 space-y-2 min-w-0">
            {/* Compact Player Identity Card */}
            <div className="bg-white border border-[#E7EDE8] rounded-xl p-2.5 sm:p-3 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#159447] to-[#08743A] text-white font-['Outfit'] text-base font-extrabold flex items-center justify-center shadow-[0_2px_8px_rgba(21,148,71,0.2)] border-2 border-[#F5BD42] shrink-0">
                  {user.initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <h2 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326] truncate">
                      {user.firstName} {user.lastName}
                    </h2>
                    <span
                      title="Cloud Firestore connection status"
                      className="font-mono text-[9px] font-extrabold text-[#08743A] bg-[#E6F6EB] px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0"
                    >
                      <Database size={10} className="text-[#159447]" />
                      {firestoreConnected ? 'SYNC' : '...'}
                    </span>
                  </div>
                  <p className="text-[10.5px] text-[#68776D] font-mono truncate">
                    {user.username} · TG #{user.id}
                  </p>
                  {firebaseUserEmail && (
                    <p className="text-[10px] text-[#168A49] font-extrabold truncate">
                      ✓ {firebaseUserEmail}
                    </p>
                  )}
                </div>
              </div>

              {/* Telegram Mini App Server Auth / Sign-Out Action */}
              {firebaseUid ? (
                <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8]">
                  <span className="text-[10px] font-mono text-[#68776D] truncate">
                    UID: {firebaseUid.slice(0, 14)}...
                  </span>
                  <button
                    type="button"
                    onClick={onSignOutFirebase}
                    className="px-2 py-1 rounded-md border border-[#E7EDE8] bg-white text-[#183326] text-[10.5px] font-extrabold flex items-center gap-1 hover:border-[#159447]/40 hover:bg-[#E6F6EB] min-h-[28px]"
                  >
                    <LogOut size={11} />
                    {lang === 'am' ? 'ውጣ' : 'Sign Out'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onSignInGoogle}
                  className="w-full py-1.5 px-3 rounded-lg bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-[11px] font-extrabold flex items-center justify-center gap-1.5 shadow-2xs hover:brightness-105 min-h-[32px]"
                >
                  <LogIn size={12} />
                  {lang === 'am' ? 'በቴሌግራም አረጋግጥ' : 'Verify Telegram Auth'}
                </button>
              )}
            </div>

            {/* Server-Verified "My Telegram ID" Section */}
            <div
              data-testid="my-telegram-id-section"
              title={
                lang === 'am'
                  ? 'ከቴሌግራም Mini App የተፈረመ initData በሰርቨር ላይ የተረጋገጠ'
                  : 'Cryptographically verified Telegram Mini App initData on the server'
              }
              className="bg-white border border-[#159447]/35 rounded-xl p-2.5 sm:p-3 space-y-1.5 shadow-[0_2px_8px_rgba(24,51,38,0.04)]"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] flex items-center gap-1">
                  <ShieldCheck size={14} className="text-[#159447]" />
                  {lang === 'am' ? 'የቴሌግራም መለያ (Telegram ID)' : 'My Telegram ID'}
                  <CircleHelp size={11} className="text-[#68776D] opacity-70" />
                </h3>
                <span
                  className={`text-[9.5px] font-extrabold px-1.5 py-0.5 rounded shrink-0 ${
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
                    : 'Unverified'}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8]">
                <code
                  data-testid="verified-telegram-id-value"
                  className="font-mono text-xs font-extrabold text-[#183326] select-all block truncate"
                >
                  {serverVerifiedTelegramId !== null
                    ? String(serverVerifiedTelegramId)
                    : lang === 'am'
                    ? 'በቴሌግራም Mini App ይክፈቱ'
                    : 'Open in Telegram Mini App'}
                </code>

                <button
                  type="button"
                  data-testid="copy-telegram-id-btn"
                  disabled={serverVerifiedTelegramId === null}
                  onClick={handleCopyTelegramId}
                  className={`px-2 py-1 rounded-md text-[10.5px] font-extrabold flex items-center gap-1 transition-colors min-h-[28px] shrink-0 ${
                    serverVerifiedTelegramId !== null
                      ? 'bg-[#159447] text-white hover:bg-[#08743A] cursor-pointer'
                      : 'bg-[#E7EDE8] text-[#68776D] cursor-not-allowed'
                  }`}
                >
                  {copiedTelegramId ? <Check size={11} /> : <Copy size={11} />}
                  {copiedTelegramId
                    ? lang === 'am'
                      ? 'ተቀድቷል'
                      : 'Copied'
                    : lang === 'am'
                    ? 'ቅዳ'
                    : 'Copy'}
                </button>
              </div>
            </div>
          </section>

          <section className="lg:col-span-6 space-y-2 min-w-0">
            {/* Secure Phone Number Registration & Verification (PII-Isolated Subcollection) */}
            <form
              onSubmit={handlePhoneSubmit}
              title="Stored strictly in /users/{uid}/private/contact"
              className="bg-white border border-[#E7EDE8] rounded-xl p-2.5 sm:p-3 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] flex items-center gap-1">
                  <Lock size={13} className="text-[#159447]" />
                  {lang === 'am' ? 'ስልክ ቁጥር ማረጋገጫ' : 'Phone Verification'}
                </h3>
                <span
                  className={`text-[9.5px] font-extrabold px-1.5 py-0.5 rounded shrink-0 ${
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <button
                  type="button"
                  disabled={phoneBusy || phoneVerified}
                  onClick={() => void handleNativeTelegramContact()}
                  className="w-full px-2.5 py-1 rounded-lg border border-[#159447]/40 bg-[#E6F6EB] text-[#08743A] text-[11px] font-extrabold flex items-center justify-center gap-1 min-h-[32px] disabled:opacity-60"
                >
                  <Phone size={11} />
                  {phoneBusy
                    ? '...'
                    : lang === 'am'
                      ? 'በቴሌግራም ስልክ አጋራ'
                      : 'Share Telegram Contact'}
                </button>

                <a
                  href="https://t.me/AdeyBingoGameBot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full px-2.5 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[#183326] text-[11px] font-extrabold flex items-center justify-center gap-1 min-h-[32px]"
                >
                  <ExternalLink size={11} className="text-[#159447]" />
                  {lang === 'am' ? 'በ@AdeyBingoGameBot ያጋሩ' : 'Share in @AdeyBingoGameBot'}
                </a>
              </div>

              {phoneVerified && phoneInput ? (
                <p className="text-[10.5px] font-mono font-bold text-[#08743A]">
                  {lang === 'am' ? `የተረጋገጠ ስልክ፦ ${phoneInput}` : `Verified Phone: ${phoneInput}`}
                </p>
              ) : (
                <p className="text-[10px] font-bold text-[#68776D]">
                  {lang === 'am'
                    ? '🔒 ስልክ ቁጥር የሚረጋገጠው በቴሌግራም ቀጥተኛ የስልክ ማጋራት (Share Contact) ብቻ ነው፤ በጽሁፍ የሚገባ ቁጥር አይረጋገጥም።'
                    : '🔒 Phone numbers are verified only via native Telegram contact sharing; typed numbers are never verified.'}
                </p>
              )}

              {phoneError && <p className="text-[10.5px] font-bold text-[#D94B4B]">{phoneError}</p>}
            </form>

            {/* Motion Accessibility & Collapsible Telegram Bot Diagnostics */}
            <div className="bg-white border border-[#E7EDE8] rounded-xl p-2.5 space-y-1.5 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
              <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8]">
                <span className="text-[11px] font-extrabold text-[#183326]">
                  {lang === 'am' ? 'እንቅስቃሴ ቀንስ (Reduced Motion)' : 'Reduced Motion'}
                </span>
                <button
                  type="button"
                  onClick={onToggleReducedMotion}
                  className={`px-2.5 py-0.5 rounded-md text-[10.5px] font-extrabold min-h-[28px] border ${
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
                  className="w-full px-2.5 py-1.5 flex items-center justify-between text-[11px] font-extrabold text-[#183326] hover:bg-[#E6F6EB]/50 min-h-[32px]"
                >
                  <span>
                    {lang === 'am' ? 'የቴሌግራም ቦት ምርመራ' : 'Telegram Bot & Diagnostics'}
                  </span>
                  {showAdvancedBot ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>

                {showAdvancedBot && (
                  <div className="p-2 space-y-2 border-t border-[#E7EDE8]">
                    <div className="p-2 rounded-lg bg-white border border-[#E7EDE8] space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-extrabold text-[#183326]">
                          initData Check
                        </span>
                        <button
                          type="button"
                          onClick={onValidateTelegramInitData}
                          className="px-2 py-0.5 rounded bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] text-[10px] font-extrabold hover:bg-[#159447] hover:text-white transition-colors shrink-0"
                        >
                          {lang === 'am' ? 'ፈትሽ' : 'Verify'}
                        </button>
                      </div>
                      <p className="text-[10px] text-[#68776D] font-mono leading-snug break-words">
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-2 items-start">
          <section className="lg:col-span-6 bg-white border border-[#E7EDE8] rounded-xl p-2.5 sm:p-3 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
            <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326]">
              {lang === 'am' ? 'ተደጋጋሚ ጥያቄዎች (FAQ)' : 'FAQ'}
            </h3>
            <div className="space-y-1.5">
              {FAQ_ITEMS.map((faq, idx) => (
                <div
                  key={idx}
                  className="p-2 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] space-y-0.5"
                >
                  <b className="text-[11px] font-extrabold text-[#159447] block">
                    {lang === 'am' ? faq.qAm : faq.qEn}
                  </b>
                  <p className="text-[10.5px] text-[#68776D] leading-snug">
                    {lang === 'am' ? faq.aAm : faq.aEn}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="lg:col-span-6 bg-white border border-[#E7EDE8] rounded-xl p-2.5 sm:p-3 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
            <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326]">
              {lang === 'am' ? 'የድጋፍ መልዕክት' : 'Player Support'}
            </h3>

            <form onSubmit={handleSupportSubmit} className="space-y-1.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <select
                  value={ticketCategory}
                  onChange={(e) => setTicketCategory(e.target.value)}
                  aria-label="Support Topic"
                  className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-bold text-[#183326] min-h-[32px] focus:outline-none focus:border-[#159447]"
                >
                  <option value="game_rules">
                    {lang === 'am' ? 'የጨዋታ ህጎች' : 'Game Rules'}
                  </option>
                  <option value="demo_wallet">
                    {lang === 'am' ? 'ቦርሳ እና ሂሳብ' : 'Wallet & Balance'}
                  </option>
                  <option value="technical">
                    {lang === 'am' ? 'የቴክኒክ እገዛ' : 'Technical'}
                  </option>
                </select>

                <input
                  type="text"
                  value={ticketSubject}
                  onChange={(e) => setTicketSubject(e.target.value)}
                  placeholder={lang === 'am' ? 'ርዕስ...' : 'Subject...'}
                  aria-label="Support Subject"
                  className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-bold text-[#183326] placeholder:text-[#68776D] min-h-[32px] focus:outline-none focus:border-[#159447]"
                />
              </div>

              <textarea
                rows={2}
                value={ticketMessage}
                onChange={(e) => setTicketMessage(e.target.value)}
                placeholder={lang === 'am' ? 'መልዕክትዎን ይጻፉ...' : 'Your message...'}
                aria-label="Support Message"
                className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-medium text-[#183326] placeholder:text-[#68776D] focus:outline-none focus:border-[#159447]"
              />

              {ticketError && <p className="text-[10.5px] font-bold text-[#D94B4B]">{ticketError}</p>}

              <button
                type="submit"
                className="w-full py-1.5 px-3 rounded-lg bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-[11px] font-extrabold flex items-center justify-center gap-1.5 min-h-[32px] shadow-[0_2px_8px_rgba(21,148,71,0.18)]"
              >
                <Send size={12} />
                {lang === 'am' ? 'ላክ' : 'Submit'}
              </button>
            </form>

            {tickets.length > 0 && (
              <div className="pt-1.5 border-t border-[#E7EDE8] space-y-1">
                {tickets.map((tkt) => (
                  <div
                    key={tkt.id}
                    className="p-2 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] flex items-center justify-between text-[11px]"
                  >
                    <div>
                      <b className="text-[#183326] block">{tkt.subject}</b>
                      <small className="text-[#68776D] text-[9.5px]">
                        {tkt.id} · {tkt.createdAt}
                      </small>
                    </div>
                    <span className="font-extrabold text-[#159447] bg-[#E6F6EB] px-1.5 py-0.5 rounded text-[10px]">
                      {tkt.status === 'answered' || tkt.status === 'resolved'
                        ? lang === 'am'
                          ? 'ተመልሷል'
                          : 'Resolved'
                        : tkt.status === 'in_review'
                        ? lang === 'am'
                          ? 'በግምገማ ላይ'
                          : 'In Review'
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

      {/* 4. TERMS & CONDITIONS SCREEN (Preserves Essential Legal & Safety Information) */}
      {mode === 'terms' && (
        <section className="bg-white border border-[#E7EDE8] rounded-xl p-3 space-y-2.5 max-w-4xl shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
          <div className="flex items-center gap-1.5 text-[#159447]">
            <ShieldCheck size={18} />
            <h2 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326]">
              {lang === 'am'
                ? 'ADEYBINGO — የጨዋታ ህጎች እና የህግ ማሳሰቢያ'
                : 'ADEYBINGO — Game Rules, Terms & Safety Notice'}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] text-[#68776D] leading-snug">
            <div className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] space-y-1">
              <b className="text-xs font-extrabold text-[#159447] block">
                {lang === 'am' ? '1. የጨዋታ ስርዓት እና ደህንነት' : '1. Game Rules & Security'}
              </b>
              <ul className="space-y-0.5 list-disc pl-4 text-[#183326]">
                <li>
                  {lang === 'am'
                    ? 'በእያንዳንዱ ክፍል ከ 1–600 የተቆጠሩ ካርዶች ይገኛሉ (ቢበዛ 4 ካርድ)።'
                    : '1 to 600 unique deterministic cards per room (max 4 cards per player).'}
                </li>
                <li>
                  {lang === 'am'
                    ? 'የስልክ ቁጥሮች በ /users/{uid}/private/contact ውስጥ ተለይተው ይጠበቃሉ።'
                    : 'Phone numbers are isolated in /users/{uid}/private/contact.'}
                </li>
                <li>
                  {lang === 'am'
                    ? 'የ60 ሰከንድ የሎቢ ቆጠራ እና ቢያንስ 3 ብቁ ተጫዋቾች ያስፈልጋሉ።'
                    : '60-second lobby countdown and minimum 3 eligible players.'}
                </li>
              </ul>
            </div>

            <div className="p-2.5 rounded-xl bg-[#FEF5DC]/75 border border-[#F5BD42] space-y-1 text-[#183326]">
              <b className="text-xs font-extrabold text-[#9A6B0B] block">
                {lang === 'am'
                  ? '2. የህግ እና የሙከራ (Sandbox) ገደብ'
                  : '2. Regulatory & Sandbox Compliance Notice'}
              </b>
              <p>
                {lang === 'am'
                  ? 'ይህ የADEYBINGO እትም የሙከራ (Demo Sandbox) ነው። የህግ እና የክፍያ ተቋማት ማረጋገጫ እስኪጠናቀቅ እውነተኛ የገንዘብ ክፍያ አይሰራም።'
                  : 'This release operates strictly in Demo Sandbox Mode. Real-money deposits, withdrawals, and cash prizes are disabled pending full regulatory verification.'}
              </p>
              <p className="font-extrabold text-[#08743A]">
                {lang === 'am'
                  ? '18+ ዕድሜያቸው ከ18 ዓመት በላይ ለሆኑ ብቻ።'
                  : '18+ Responsible Gaming & Fair Play Policy.'}
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
