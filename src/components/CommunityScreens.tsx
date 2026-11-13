import { useState } from 'react';
import {
  Gift,
  Copy,
  Check,
  UserPlus,
  User,
  History,
  Headphones,
  FileText,
  Send,
  Volume2,
  CheckSquare,
  ShieldCheck,
  Phone,
  LogIn,
  LogOut,
  Database,
  Lock,
} from 'lucide-react';
import {
  GameHistoryItem,
  Language,
  ReferralRecord,
  ScreenId,
  SupportTicket,
} from '../types/bingo';
import { TelegramUserProfile } from '../utils/telegram';
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
  telegramBackendStatus: string;
  onValidateTelegramInitData: () => Promise<void>;
  demoBalance: number;
  referrals: ReferralRecord[];
  onSimulateFriendJoin: (friendName: string) => void;
  gameHistory: GameHistoryItem[];
  tickets: SupportTicket[];
  onSubmitSupportTicket: (category: string, subject: string, message: string) => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  autoMark: boolean;
  onToggleAutoMark: () => void;
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
  telegramBackendStatus,
  onValidateTelegramInitData,
  demoBalance,
  referrals,
  onSimulateFriendJoin,
  gameHistory,
  tickets,
  onSubmitSupportTicket,
  soundEnabled,
  onToggleSound,
  autoMark,
  onToggleAutoMark,
  reducedMotion,
  onToggleReducedMotion,
  onNavigate,
}: CommunityScreensProps) {
  const [copied, setCopied] = useState(false);
  const [newFriendName, setNewFriendName] = useState('');

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

  const inviteLink = `https://t.me/AdeyBingoBot?start=ADEY-${user.id}`;

  const handleCopyInvite = () => {
    try {
      navigator.clipboard?.writeText(inviteLink);
    } catch {
      // Ignore clipboard errors in iframe
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
    <div className="space-y-5">
      {/* Sub-navigation bar across Referral, Profile, Support, and Terms */}
      <div className="flex flex-wrap items-center gap-1.5 bg-white border border-[#e3ede6] rounded-2xl p-2">
        {(
          [
            { id: 'referral', icon: Gift, am: 'ጓደኛ ይጋብዙ (Referral)', en: 'Referral System' },
            { id: 'profile', icon: User, am: 'መገለጫ እና ደህንነት (Profile)', en: 'Profile & Security' },
            { id: 'support', icon: Headphones, am: 'ድጋፍ (Support)', en: 'Help & Support' },
            { id: 'terms', icon: FileText, am: 'ህጎች እና ደንቦች (Terms)', en: 'Terms & Rules' },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = mode === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onNavigate(tab.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-colors ${
                active
                  ? 'bg-[#087e50] text-white'
                  : 'text-[#3d5f4c] hover:bg-[#eff7f2]'
              }`}
            >
              <Icon size={14} />
              {lang === 'am' ? tab.am : tab.en}
            </button>
          );
        })}
      </div>

      {/* 1. REFERRAL SYSTEM SCREEN */}
      {mode === 'referral' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <section className="lg:col-span-5 bg-gradient-to-br from-[#075d3c] via-[#087e50] to-[#15a466] text-white rounded-3xl p-6 space-y-4 shadow-md">
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#fde047]">
              ✦ {lang === 'am' ? 'ይጋብዙ እና ያድጉ' : 'INVITE & GROW'}
            </span>
            <h2 className="font-['Outfit'] text-3xl font-extrabold leading-tight">
              {lang === 'am'
                ? 'ለእርስዎ 20 ETB · ለጓደኛዎ 15 ETB የሙከራ ቦነስ!'
                : 'Earn 20 ETB Inviter & 15 ETB Invitee Demo Bonus!'}
            </h2>
            <p className="text-xs text-[#d6f5e3] leading-relaxed">
              {lang === 'am'
                ? 'የቴሌግራም መጋበዣ ሊንክዎን ለጓደኞችዎ ያጋሩ። ሲቀላቀሉ የሙከራ ክሬዲት ወዲያውኑ ይጨመራል።'
                : 'Share your unique Telegram Mini App invite link. Both you and your friend receive demo credits.'}
            </p>

            <div className="bg-black/20 p-3 rounded-2xl space-y-2">
              <small className="text-[10px] uppercase tracking-wider text-[#c8f6d9] block">
                {lang === 'am' ? 'የእርስዎ የግብዣ ሊንክ' : 'YOUR PERSONAL INVITE LINK'}
              </small>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono truncate bg-white/10 px-3 py-2 rounded-xl">
                  {inviteLink}
                </code>
                <button
                  type="button"
                  onClick={handleCopyInvite}
                  className="px-3.5 py-2 rounded-xl bg-[#f2c24b] text-[#452c04] text-xs font-extrabold flex items-center gap-1 shrink-0"
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
            </div>

            <div className="bg-white/10 border border-white/20 rounded-2xl p-3.5 space-y-2.5">
              <small className="text-[11px] font-bold text-[#fde047] block">
                {lang === 'am'
                  ? 'የሙከራ ግብዣ ማስመሰያ (Simulate Friend Referral)'
                  : 'Test Referral Flow (Demo Simulator)'}
              </small>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newFriendName}
                  onChange={(e) => setNewFriendName(e.target.value)}
                  placeholder={lang === 'am' ? 'የጓደኛ ስም (ምሳሌ፦ ሜሮን)...' : 'Friend name (e.g. Meron)...'}
                  aria-label="Friend name to simulate referral"
                  className="flex-1 px-3 py-2 rounded-xl bg-white text-[#193b2b] text-xs font-bold placeholder:text-[#7e9487]"
                />
                <button
                  type="button"
                  onClick={() => {
                    onSimulateFriendJoin(newFriendName.trim() || 'Marta G.');
                    setNewFriendName('');
                  }}
                  className="px-3.5 py-2 rounded-xl bg-white text-[#087e50] text-xs font-extrabold flex items-center gap-1 shrink-0"
                >
                  <UserPlus size={14} />
                  +20 ETB
                </button>
              </div>
            </div>
          </section>

          <section className="lg:col-span-7 bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b]">
                {lang === 'am'
                  ? `የተጋበዙ ጓደኞች ዝርዝር (${referrals.length})`
                  : `Invited Friends (${referrals.length})`}
              </h3>
              <span className="text-xs font-extrabold text-[#087e50] tabular-nums">
                +
                {referrals
                  .filter((r) => r.status === 'qualified')
                  .reduce((sum, r) => sum + r.inviterBonus, 0)}{' '}
                ETB (Demo)
              </span>
            </div>

            <div className="divide-y divide-[#edf4ef]">
              {referrals.map((ref) => (
                <div
                  key={ref.id}
                  className="py-3.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-9 h-9 rounded-full bg-[#e4f7ec] text-[#087e50] font-extrabold text-xs flex items-center justify-center">
                      {ref.friendName.slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <b className="text-xs font-extrabold text-[#193b2b] block">
                        {ref.friendName}{' '}
                        <span className="font-normal text-[#6f8578]">{ref.handle}</span>
                      </b>
                      <small className="text-[11px] text-[#7a9082]">{ref.joinedAt}</small>
                    </div>
                  </div>

                  <div className="text-right">
                    <b className="font-['Outfit'] text-sm font-extrabold text-[#087e50] tabular-nums block">
                      +{ref.inviterBonus} ETB
                    </b>
                    <small className="text-[10px] text-[#6d8375]">
                      {ref.status === 'qualified'
                        ? lang === 'am'
                          ? '✓ የተረጋገጠ (Demo)'
                          : '✓ Qualified (Demo)'
                        : lang === 'am'
                        ? 'በመጠባበቅ ላይ'
                        : 'Pending'}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* 2. PROFILE, FIREBASE AUTH, PII PHONE VERIFICATION & SETTINGS */}
      {mode === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <section className="lg:col-span-5 space-y-4 min-w-0">
            {/* Player Identity & Firebase Authentication Card */}
            <div className="bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#19bb70] to-[#087e50] text-white font-['Outfit'] text-2xl font-extrabold flex items-center justify-center shadow-md shrink-0">
                  {user.initials}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-[10px] font-extrabold uppercase text-[#12a566] block truncate">
                    {firebaseUid
                      ? 'FIREBASE AUTH · CLOUD SYNC ACTIVE'
                      : 'LOCAL DEMO SESSION · SIGN IN FOR CLOUD'}
                  </span>
                  <h2 className="font-['Outfit'] text-2xl font-extrabold text-[#193b2b] truncate">
                    {user.firstName} {user.lastName}
                  </h2>
                  <p className="text-xs text-[#698072] font-mono truncate">
                    {user.username} · TG #{user.id}
                  </p>
                  {firebaseUserEmail && (
                    <p className="text-[11px] text-[#087e50] font-bold truncate mt-0.5">
                      ✓ {firebaseUserEmail}
                    </p>
                  )}
                </div>
              </div>

              {/* Firebase Sign-In / Sign-Out Action */}
              <div className="p-3.5 rounded-2xl bg-[#f4faf6] border border-[#dcece1] space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-[#254936] flex items-center gap-1.5">
                    <Database size={14} className="text-[#087e50]" />
                    {lang === 'am' ? 'Cloud Firestore ግንኙነት' : 'Cloud Firestore Status'}
                  </span>
                  <span className="font-mono text-[11px] font-bold text-[#087e50]">
                    {firestoreConnected ? 'CONNECTED' : 'CHECKING'}
                  </span>
                </div>

                {firebaseUid ? (
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="text-[11px] font-mono text-[#52705f] truncate">
                      UID: {firebaseUid.slice(0, 14)}...
                    </span>
                    <button
                      type="button"
                      onClick={onSignOutFirebase}
                      className="px-3 py-1.5 rounded-xl border border-[#d5e5db] bg-white text-[#355644] text-xs font-extrabold flex items-center gap-1.5 hover:bg-[#eef6f1]"
                    >
                      <LogOut size={13} />
                      {lang === 'am' ? 'ውጣ' : 'Sign Out'}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={onSignInGoogle}
                    className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white text-xs font-extrabold flex items-center justify-center gap-2 shadow-xs hover:brightness-105"
                  >
                    <LogIn size={15} />
                    {lang === 'am'
                      ? 'በGoogle ይግቡ (Firebase Cloud Sync)'
                      : 'Sign In with Google (Enable Firestore Sync)'}
                  </button>
                )}
              </div>

              {/* Telegram Mini App Backend initData Validator */}
              <div className="p-3.5 rounded-2xl bg-[#f8fbf9] border border-[#e3eee7] space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-[#193b2b]">
                    {lang === 'am'
                      ? 'የቴሌግራም initData የሰርቨር ማረጋገጫ'
                      : 'Telegram initData Backend Check'}
                  </span>
                  <button
                    type="button"
                    onClick={onValidateTelegramInitData}
                    className="px-2.5 py-1 rounded-lg bg-[#e7f8ed] text-[#087e50] text-[11px] font-extrabold hover:bg-[#d5f2e0] shrink-0"
                  >
                    {lang === 'am' ? 'አሁን ፈትሽ' : 'Verify on Server'}
                  </button>
                </div>
                <p className="text-[11px] text-[#5e7768] font-mono leading-relaxed break-words">
                  {telegramBackendStatus}
                </p>
              </div>
            </div>

            {/* Secure Phone Number Registration & Verification (PII-Isolated Subcollection) */}
            <form
              onSubmit={handlePhoneSubmit}
              className="bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[10px] font-extrabold uppercase text-[#12a566] flex items-center gap-1">
                    <Lock size={12} />
                    {lang === 'am' ? 'የግል መረጃ ጥበቃ (PII ISOLATED)' : 'PII-ISOLATED SUBCOLLECTION'}
                  </span>
                  <h3 className="font-['Outfit'] text-lg font-extrabold text-[#193b2b]">
                    {lang === 'am' ? 'የስልክ ቁጥር ምዝገባ እና ማረጋገጫ' : 'Phone Registration & Verification'}
                  </h3>
                </div>
                <span
                  className={`text-[11px] font-extrabold px-2.5 py-1 rounded-lg shrink-0 ${
                    phoneVerified
                      ? 'bg-[#e7f8ed] text-[#087e50]'
                      : 'bg-[#fef5dc] text-[#8a6109]'
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

              <p className="text-xs text-[#5d7667] leading-relaxed break-words">
                {lang === 'am'
                  ? 'ስልክ ቁጥርዎ በ /users/{uid}/private/contact ውስጥ በጥብቅ ደህንነት ይቀመጣል።'
                  : 'Stored strictly in /users/{uid}/private/contact — inaccessible to other players.'}
              </p>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1">
                  {lang === 'am' ? 'የማረጋገጫ ዘዴ' : 'Verification Method'}
                </label>
                <select
                  value={phoneMethod}
                  onChange={(e) =>
                    setPhoneMethod(
                      e.target.value as 'telegram_contact' | 'sms_otp_demo'
                    )
                  }
                  aria-label="Phone Verification Method"
                  className="w-full px-3 py-2 rounded-xl border border-[#d7e6dc] bg-[#f9fcfa] text-xs font-bold text-[#193b2b]"
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
                <label className="block text-xs font-bold text-[#355644] mb-1">
                  {lang === 'am' ? 'የስልክ ቁጥር' : 'Phone Number'}
                </label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="+251911223344"
                    aria-label="Phone Number for Verification"
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-[#d7e6dc] bg-white text-xs font-mono font-bold text-[#193b2b]"
                  />
                  <button
                    type="submit"
                    disabled={phoneBusy}
                    className="px-4 py-2 rounded-xl bg-[#087e50] text-white text-xs font-extrabold flex items-center gap-1.5 shrink-0"
                  >
                    <Phone size={13} />
                    {phoneBusy
                      ? '...'
                      : lang === 'am'
                      ? 'አረጋግጥ'
                      : 'Verify'}
                  </button>
                </div>
              </div>

              {phoneError && (
                <p className="text-xs font-bold text-red-600">{phoneError}</p>
              )}
            </form>
          </section>

          <section className="lg:col-span-7 space-y-4 min-w-0">
            {/* Milestone 3: Telegram Bot & Mini App Integration Console */}
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

            {/* Game Preferences Card */}
            <div className="bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-3">
              <h3 className="font-['Outfit'] text-lg font-extrabold text-[#193b2b]">
                {lang === 'am' ? 'የጨዋታ ምርጫዎች' : 'Game Preferences'}
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex items-center justify-between p-3 rounded-xl bg-[#f6fbf8] border border-[#e2efe6]">
                  <span className="text-xs font-bold text-[#2b4d3b]">
                    {lang === 'am' ? 'ቋንቋ (Language)' : 'App Language'}
                  </span>
                  <div className="flex gap-1 bg-white p-1 rounded-lg border border-[#dce8df]">
                    <button
                      type="button"
                      onClick={() => onChangeLang('am')}
                      className={`px-2.5 py-1 rounded text-xs font-extrabold ${
                        lang === 'am' ? 'bg-[#087e50] text-white' : 'text-[#496554]'
                      }`}
                    >
                      አማርኛ
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeLang('en')}
                      className={`px-2.5 py-1 rounded text-xs font-extrabold ${
                        lang === 'en' ? 'bg-[#087e50] text-white' : 'text-[#496554]'
                      }`}
                    >
                      EN
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-[#f6fbf8] border border-[#e2efe6]">
                  <span className="text-xs font-bold text-[#2b4d3b] flex items-center gap-1.5">
                    <Volume2 size={15} className="text-[#087e50]" />
                    {lang === 'am' ? 'ድምፅ (Sound FX)' : 'Sound Effects'}
                  </span>
                  <button
                    type="button"
                    onClick={onToggleSound}
                    className={`px-3 py-1 rounded-lg text-xs font-extrabold ${
                      soundEnabled
                        ? 'bg-[#087e50] text-white'
                        : 'bg-white text-[#6d8375] border border-[#dce8df]'
                    }`}
                  >
                    {soundEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-[#f6fbf8] border border-[#e2efe6]">
                  <span className="text-xs font-bold text-[#2b4d3b] flex items-center gap-1.5">
                    <CheckSquare size={15} className="text-[#087e50]" />
                    {lang === 'am' ? 'አውቶ ምልክት' : 'Auto-Mark'}
                  </span>
                  <button
                    type="button"
                    onClick={onToggleAutoMark}
                    className={`px-3 py-1 rounded-lg text-xs font-extrabold ${
                      autoMark
                        ? 'bg-[#087e50] text-white'
                        : 'bg-white text-[#6d8375] border border-[#dce8df]'
                    }`}
                  >
                    {autoMark ? 'AUTO' : 'MANUAL'}
                  </button>
                </div>

                <div className="flex items-center justify-between p-3 rounded-xl bg-[#f6fbf8] border border-[#e2efe6]">
                  <span className="text-xs font-bold text-[#2b4d3b]">
                    {lang === 'am' ? 'እንቅስቃሴ ቀንስ' : 'Reduced Motion'}
                  </span>
                  <button
                    type="button"
                    onClick={onToggleReducedMotion}
                    className={`px-3 py-1 rounded-lg text-xs font-extrabold ${
                      reducedMotion
                        ? 'bg-[#087e50] text-white'
                        : 'bg-white text-[#6d8375] border border-[#dce8df]'
                    }`}
                  >
                    {reducedMotion ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>
            </div>

            {/* Game History Card */}
            <div className="bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b] flex items-center gap-2">
                  <History size={18} className="text-[#087e50]" />
                  {lang === 'am' ? 'የጨዋታ ታሪክ (Game History)' : 'Recent Game History'}
                </h3>
                <span className="text-xs text-[#698072] tabular-nums">
                  {gameHistory.length} {lang === 'am' ? 'ዙሮች' : 'rounds'} ·{' '}
                  {demoBalance.toFixed(0)} ETB
                </span>
              </div>

              <div className="divide-y divide-[#edf4ef]">
                {gameHistory.map((item) => (
                  <div
                    key={item.id}
                    className="py-3.5 flex items-center justify-between gap-3"
                  >
                    <div>
                      <b className="text-xs font-extrabold text-[#193b2b] block">
                        {lang === 'am' ? item.roomNameAm : item.roomNameEn}
                      </b>
                      <div className="text-[11px] text-[#6d8375] mt-0.5">
                        <span>{item.playedAt}</span>
                        <span aria-hidden="true"> · </span>
                        <span>
                          {lang === 'am' ? 'ካርዶች፦' : 'Cards:'}{' '}
                          {item.cardIds.map((c) => `#${c}`).join(', ')}
                        </span>
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

                    <div className="text-right">
                      <b
                        className={`font-['Outfit'] text-sm font-extrabold tabular-nums block ${
                          item.outcome === 'won' ? 'text-[#087e50]' : 'text-[#5b7565]'
                        }`}
                      >
                        {item.outcome === 'won'
                          ? `+${item.prizeDemo} ETB (BINGO)`
                          : `${item.entryFeeDemo} ETB`}
                      </b>
                      <small className="text-[10px] text-[#7a9082] tabular-nums">
                        {item.callsCount} {lang === 'am' ? 'ጥሪዎች' : 'calls'}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* 3. SUPPORT SCREEN */}
      {mode === 'support' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <section className="lg:col-span-6 bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4">
            <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b]">
              {lang === 'am' ? 'ተደጋጋሚ ጥያቄዎች (FAQ)' : 'Frequently Asked Questions'}
            </h3>
            <div className="space-y-3">
              {FAQ_ITEMS.map((faq, idx) => (
                <div
                  key={idx}
                  className="p-4 rounded-2xl bg-[#f6fbf8] border border-[#e0ede4] space-y-1.5"
                >
                  <b className="text-xs font-extrabold text-[#11422b] block">
                    {lang === 'am' ? faq.qAm : faq.qEn}
                  </b>
                  <p className="text-xs text-[#4f6b5b] leading-relaxed">
                    {lang === 'am' ? faq.aAm : faq.aEn}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="lg:col-span-6 bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4">
            <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b]">
              {lang === 'am' ? 'የድጋፍ መልዕክት ይላኩ' : 'Contact Player Support'}
            </h3>

            <form onSubmit={handleSupportSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1">
                  {lang === 'am' ? 'ምድብ' : 'Topic'}
                </label>
                <select
                  value={ticketCategory}
                  onChange={(e) => setTicketCategory(e.target.value)}
                  aria-label="Support Topic"
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-[#f9fcfa] text-xs font-bold text-[#193b2b]"
                >
                  <option value="game_rules">
                    {lang === 'am' ? 'የጨዋታ ህጎች እና ካርዶች' : 'Game Rules & Cards'}
                  </option>
                  <option value="demo_wallet">
                    {lang === 'am' ? 'የሙከራ ቦርሳ (Demo Wallet)' : 'Demo Wallet & Credits'}
                  </option>
                  <option value="technical">
                    {lang === 'am' ? 'የቴክኒክ እገዛ' : 'Technical Feedback'}
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1">
                  {lang === 'am' ? 'ርዕስ' : 'Subject'}
                </label>
                <input
                  type="text"
                  value={ticketSubject}
                  onChange={(e) => setTicketSubject(e.target.value)}
                  placeholder={lang === 'am' ? 'አጭር ርዕስ ይጻፉ...' : 'Brief summary...'}
                  aria-label="Support Subject"
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-white text-xs font-bold text-[#193b2b]"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1">
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
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-white text-xs font-medium text-[#193b2b]"
                />
              </div>

              {ticketError && (
                <p className="text-xs font-bold text-red-600">{ticketError}</p>
              )}

              <button
                type="submit"
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white text-xs font-extrabold flex items-center justify-center gap-1.5"
              >
                <Send size={14} />
                {lang === 'am' ? 'የድጋፍ ጥያቄ ላክ' : 'Submit Support Ticket'}
              </button>
            </form>

            {tickets.length > 0 && (
              <div className="pt-3 border-t border-[#edf4ef] space-y-2">
                <small className="text-[10px] font-extrabold uppercase text-[#6e8577] block">
                  {lang === 'am' ? 'የእርስዎ የድጋፍ ጥያቄዎች' : 'YOUR SUPPORT TICKETS'} ({tickets.length})
                </small>
                {tickets.map((tkt) => (
                  <div
                    key={tkt.id}
                    className="p-3 rounded-xl bg-[#f5faf7] border border-[#e3efe7] flex items-center justify-between text-xs"
                  >
                    <div>
                      <b className="text-[#193b2b] block">{tkt.subject}</b>
                      <small className="text-[#6f8578]">
                        {tkt.id} · {tkt.createdAt}
                      </small>
                    </div>
                    <span className="font-bold text-[#087e50]">
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
        <section className="bg-white border border-[#e3ede6] rounded-2xl p-6 space-y-5 max-w-4xl">
          <div className="flex items-center gap-2 text-[#087e50]">
            <ShieldCheck size={22} />
            <h2 className="font-['Outfit'] text-2xl font-extrabold text-[#193b2b]">
              {lang === 'am'
                ? 'ADEYBINGO — የጨዋታ ህጎች፣ ደንቦች እና የህግ ማሳሰቢያ'
                : 'ADEYBINGO — Game Rules, Terms & Compliance Notice'}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-[#3b5948] leading-relaxed">
            <div className="p-4 rounded-2xl bg-[#f6fbf8] border border-[#e0ede4] space-y-2">
              <b className="text-sm font-extrabold text-[#11422b] block">
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

            <div className="p-4 rounded-2xl bg-[#fef8e6] border border-[#f3d683] space-y-2 text-[#5c4209]">
              <b className="text-sm font-extrabold text-[#453003] block">
                {lang === 'am'
                  ? '2. የህግ፣ የፈቃድ እና የሙከራ (Sandbox) ገደብ'
                  : '2. Regulatory & Sandbox Compliance Notice'}
              </b>
              <p>
                {lang === 'am'
                  ? 'ይህ የADEYBINGO እትም የሙከራ (Demo Sandbox) ነው። የኢትዮጵያ የህግ፣ የፈቃድ እና የክፍያ ተቋማት ማረጋገጫ እስኪጠናቀቅ ድረስ እውነተኛ ገንዘብ ማስገባት፣ ማውጣት ወይም የገንዘብ ሽልማት አይሰራም።'
                  : 'This release operates strictly in Demo Sandbox Mode. Real-money deposits, withdrawals, and cash prizes are disabled pending full legal, licensing, and payment-provider verification.'}
              </p>
              <p className="font-bold">
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
