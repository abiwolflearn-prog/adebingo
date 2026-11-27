import React, { useEffect, useState } from 'react';
import {
  BellRing,
  Bot,
  CheckCircle2,
  ExternalLink,
  Globe,
  PhoneCall,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { buildAuthenticatedHeaders, getActiveBearerToken } from '../services/firestoreService';
import { Language } from '../types/bingo';
import { TelegramUserProfile } from '../utils/telegram';
import {
  BotNotificationMessage,
  DEFAULT_BOT_BUTTON_LABELS,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  NotificationEventType,
  TelegramBotResponse,
  TelegramInlineButton,
} from '../utils/telegramBot';

interface TelegramBotConsoleProps {
  lang: Language;
  user: TelegramUserProfile;
  firebaseUid: string | null;
  onSyncLanguage: (nextLang: Language) => void;
  onPhoneVerifiedFromBot: (phone: string) => void;
}

const SLASH_COMMANDS = [
  '/start',
  '/wallet',
  '/deposit',
  '/withdraw',
  '/invite',
  '/leaderboard',
  '/history',
  '/profile',
  '/support',
  '/language',
] as const;

const AMHARIC_MENU_ROWS: readonly (readonly { label: string; isPlay?: boolean }[])[] = [
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.playBingoAm, isPlay: true },
    { label: DEFAULT_BOT_BUTTON_LABELS.myWalletAm },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.depositAm || '➕ ገንዘብ ያስገቡ' },
    { label: DEFAULT_BOT_BUTTON_LABELS.withdrawAm || '💸 ገንዘብ ያውጡ' },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.inviteFriendsAm },
    { label: DEFAULT_BOT_BUTTON_LABELS.leaderboardAm || '🏆 የደረጃ ሰንጠረዥ' },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.gameHistoryAm },
    { label: DEFAULT_BOT_BUTTON_LABELS.myProfileAm },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.supportAm },
    { label: DEFAULT_BOT_BUTTON_LABELS.languageAm },
  ],
];

const ENGLISH_MENU_ROWS: readonly (readonly { label: string; isPlay?: boolean }[])[] = [
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.playBingoEn, isPlay: true },
    { label: DEFAULT_BOT_BUTTON_LABELS.myWalletEn },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.depositEn || '➕ Deposit' },
    { label: DEFAULT_BOT_BUTTON_LABELS.withdrawEn || '💸 Withdraw' },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.inviteFriendsEn },
    { label: DEFAULT_BOT_BUTTON_LABELS.leaderboardEn || '🏆 Leaderboard' },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.gameHistoryEn },
    { label: DEFAULT_BOT_BUTTON_LABELS.myProfileEn },
  ],
  [
    { label: DEFAULT_BOT_BUTTON_LABELS.supportEn },
    { label: DEFAULT_BOT_BUTTON_LABELS.languageEn },
  ],
];

const INLINE_CALLBACK_SHORTCUTS = [
  { labelAm: '🎱 ቢንጎ ይጫወቱ', labelEn: '🎱 Play Bingo', callbackData: 'cb:play_bingo' },
  { labelAm: '💰 የእኔ ቦርሳ', labelEn: '💰 My Wallet', callbackData: 'cb:my_wallet' },
  { labelAm: '➕ ገንዘብ ያስገቡ', labelEn: '➕ Deposit', callbackData: 'cb:deposit' },
  { labelAm: '💸 ገንዘብ ያውጡ', labelEn: '💸 Withdraw', callbackData: 'cb:withdraw' },
  { labelAm: '🎁 ጓደኞችን ይጋብዙ', labelEn: '🎁 Invite Friends', callbackData: 'cb:invite_friends' },
  { labelAm: '🏆 የደረጃ ሰንጠረዥ', labelEn: '🏆 Leaderboard', callbackData: 'cb:leaderboard' },
  { labelAm: '📜 የጨዋታ ታሪክ', labelEn: '📜 Game History', callbackData: 'cb:game_history' },
  { labelAm: '👤 የእኔ መገለጫ', labelEn: '👤 My Profile', callbackData: 'cb:my_profile' },
  { labelAm: '🆘 እገዛ', labelEn: '🆘 Support', callbackData: 'cb:support' },
  { labelAm: '🌐 ቋንቋ', labelEn: '🌐 Language', callbackData: 'cb:language' },
] as const;

const NOTIFICATION_EVENTS: {
  id: NotificationEventType;
  labelAm: string;
  labelEn: string;
}[] = [
  { id: 'registration_success', labelAm: 'ምዝገባ ተሳክቷል', labelEn: 'Registration Success' },
  { id: 'game_starting', labelAm: 'ጨዋታ ሊጀምር ነው', labelEn: 'Game Starting' },
  { id: 'new_bingo_number', labelAm: 'አዲስ ቁጥር ጥሪ', labelEn: 'New Bingo Number' },
  { id: 'game_completion', labelAm: 'ዙር ተጠናቋል', labelEn: 'Game Completion' },
  { id: 'winner_announcement', labelAm: 'አሸናፊ ማሳወቂያ', labelEn: 'Winner Announcement' },
  { id: 'referral_confirmation', labelAm: 'የግብዣ ማረጋገጫ', labelEn: 'Referral Confirmation' },
  { id: 'support_response', labelAm: 'የድጋፍ ምላሽ', labelEn: 'Support Response' },
];

export const TelegramBotConsole: React.FC<TelegramBotConsoleProps> = ({
  lang,
  user,
  firebaseUid,
  onSyncLanguage,
  onPhoneVerifiedFromBot,
}) => {
  const [botReply, setBotReply] = useState<TelegramBotResponse | null>(null);
  const [outbox, setOutbox] = useState<BotNotificationMessage[]>([]);
  const [miniAppUrl, setMiniAppUrl] = useState<string>(DEFAULT_DEPLOYED_MINI_APP_URL);
  const [callbackToast, setCallbackToast] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sendBotCommand('/start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendBotCommand(
    text: string,
    extra: {
      callbackData?: string;
      callbackQueryId?: string;
      contact?: {
        phone_number: string;
        first_name: string;
        user_id?: number;
      } | null;
      overrideUid?: string;
    } = {}
  ) {
    setBusy(true);
    try {
      const token = await getActiveBearerToken();
      const headers = await buildAuthenticatedHeaders();
      const payload: Record<string, unknown> = {
        text,
        callbackData: extra.callbackData || '',
        ...(extra.callbackQueryId ? { callbackQueryId: extra.callbackQueryId } : {}),
        ...(extra.contact !== undefined ? { contact: extra.contact } : {}),
      };

      // Only send preview identity fields when no authenticated Bearer token is active or when testing spoof guard
      if (!token || extra.overrideUid) {
        payload.senderTelegramId = user.id;
        payload.firstName = user.firstName;
        payload.lastName = user.lastName || '';
        payload.username = (user.username || '').replace(/^@/, '');
        payload.firebaseUid = extra.overrideUid || firebaseUid || `tg_${user.id}`;
      }

      const resp = await fetch('/api/telegram/bot-command', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      const normalizedLanguage: Language =
        data?.language === 'en' ? 'en' : data?.language === 'am' ? 'am' : lang;
      if (!resp.ok || typeof data?.text !== 'string') {
        setBotReply({
          ok: false,
          chatId: typeof data?.chatId === 'number' ? data.chatId : user.id,
          language: normalizedLanguage,
          text:
            typeof data?.message === 'string' && data.message.trim()
              ? data.message
              : lang === 'am'
                ? 'የቴሌግራም ቦት መልስ ለማየት በቴሌግራም መለያዎ ይግቡ።'
                : 'Sign in with Telegram to inspect live bot command responses.',
          parseMode: 'Markdown',
          replyMarkup: {},
          registrationStatus: 'unregistered',
          securityCode: typeof data?.error === 'string' ? data.error : `http_${resp.status}`,
        });
        setCallbackToast('');
        return;
      }
      setBotReply({
        ...data,
        chatId: typeof data.chatId === 'number' ? data.chatId : user.id,
        language: normalizedLanguage,
      });
      if (data.callbackAnswerText) {
        setCallbackToast(data.callbackAnswerText);
      } else {
        setCallbackToast('');
      }
      if (Array.isArray(data.outbox)) {
        setOutbox(data.outbox);
      }
      const webAppBtn = data?.replyMarkup?.keyboard
        ?.flat()
        ?.find((b: { web_app?: { url?: string } }) => b?.web_app?.url);
      if (webAppBtn?.web_app?.url) {
        setMiniAppUrl(webAppBtn.web_app.url);
      }
      if (data.language && (data.language === 'am' || data.language === 'en') && data.language !== lang) {
        onSyncLanguage(data.language);
      }
      if (data.securityCode === 'contact_verified' && extra.contact?.phone_number) {
        onPhoneVerifiedFromBot(extra.contact.phone_number);
      }
    } catch {
      // Ignore network hiccup in preview
    } finally {
      setBusy(false);
    }
  }

  async function triggerNotification(event: NotificationEventType) {
    setBusy(true);
    try {
      const headers = await buildAuthenticatedHeaders();
      const resp = await fetch('/api/telegram/notify', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event,
          telegramUserId: user.id,
          payload: {
            playerName: user.firstName,
            maskedPhone: '+25191****44',
            ballNumber: 14,
            totalCalls: 19,
            winnerName: `${user.firstName} ${user.lastName || ''}`.trim(),
            winningCardId: 1,
            winningPattern: 'Horizontal Row 1',
            demoPrizeEtb: 50,
            friendName: 'Meron T.',
            inviterBonusEtb: 20,
            ticketId: 'TKT-2041',
          },
        }),
      });
      const data = await resp.json();
      if (Array.isArray(data.outbox)) {
        setOutbox(data.outbox);
      }
    } catch {
      // Ignore network error
    } finally {
      setBusy(false);
    }
  }

  function handleInlineButtonClick(btn: TelegramInlineButton) {
    if (btn.callback_data) {
      sendBotCommand('', {
        callbackData: btn.callback_data,
        callbackQueryId: `cbq_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      });
      return;
    }
    if (btn.web_app?.url) {
      sendBotCommand('', {
        callbackData: 'cb:play_bingo',
        callbackQueryId: `cbq_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      });
      return;
    }
    if (btn.url) {
      sendBotCommand('', {
        callbackData: 'cb:invite_friends',
        callbackQueryId: `cbq_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      });
    }
  }

  const effectiveBotLang: Language = botReply?.language || lang;
  const activeMenuRows = effectiveBotLang === 'en' ? ENGLISH_MENU_ROWS : AMHARIC_MENU_ROWS;
  const dynamicInlineRows = botReply?.replyMarkup?.inline_keyboard || [];

  return (
    <div className="bg-white border border-[#E7EDE8] rounded-xl p-3 space-y-2.5 text-[#183326] shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div>
          <span className="text-[9.5px] font-extrabold uppercase tracking-wider text-[#159447] flex items-center gap-1">
            <Bot size={12} />
            {lang === 'am'
              ? 'ADEYBINGO · አማርኛ-መጀመሪያ የቴሌግራም ቦት'
              : 'ADEYBINGO · AMHARIC-FIRST TELEGRAM BOT'}
          </span>
          <h3 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326]">
            {lang === 'am'
              ? 'የቴሌግራም ቦት ዋና ሜኑ፣ ቦርሳ፣ ደረጃ ሰንጠረዥ እና ማሳወቂያዎች'
              : 'Telegram Bot Main Menu, Wallet, Leaderboard & Mini App Sync'}
          </h3>
        </div>
        <span
          className={`text-[10px] font-extrabold px-2 py-0.5 rounded-md flex items-center gap-1 ${
            botReply?.registrationStatus === 'verified'
              ? 'bg-[#E6F6EB] text-[#08743A] border border-[#159447]/30'
              : botReply?.registrationStatus === 'duplicate_blocked'
              ? 'bg-[#FFF5F5] text-[#D94B4B] border border-[#D94B4B]/40'
              : 'bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42]'
          }`}
        >
          {botReply?.registrationStatus === 'verified' ? (
            <>
              <ShieldCheck size={12} />
              {lang === 'am' ? 'ስልክ እና መለያ ተረጋግጧል' : 'Bot Contact Verified'}
            </>
          ) : botReply?.registrationStatus === 'duplicate_blocked' ? (
            <>
              <ShieldAlert size={12} />
              {lang === 'am' ? 'ድጋሚ ምዝገባ ተከልክሏል' : 'Duplicate Blocked'}
            </>
          ) : (
            <>
              <PhoneCall size={12} />
              {lang === 'am' ? 'ስልክ ማጋራት ይጠበቃል' : 'Awaiting Contact Share'}
            </>
          )}
        </span>
      </div>

      {/* Slash Commands */}
      <div className="space-y-1">
        <small className="text-[10.5px] font-bold text-[#68776D] block">
          {lang === 'am' ? 'የቦት ትዕዛዞች (Bot Slash Commands):' : 'Bot Slash Commands:'}
        </small>
        <div className="flex flex-wrap gap-1">
          {SLASH_COMMANDS.map((cmd) => (
            <button
              key={cmd}
              type="button"
              disabled={busy}
              onClick={() => sendBotCommand(cmd)}
              className="px-2 py-1 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-[#08743A] font-mono text-[11px] font-extrabold hover:border-[#159447] hover:bg-[#E6F6EB]"
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>

      {/* Contact Ownership Verification Controls */}
      <div className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-extrabold text-[#183326] flex items-center gap-1">
            <PhoneCall size={12} className="text-[#159447]" />
            {lang === 'am'
              ? 'የስልክ ባለቤትነት ማረጋገጫ (Contact Ownership Check)'
              : 'Telegram Contact Ownership & Anti-Spoof Tests'}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              sendBotCommand('', {
                contact: {
                  phone_number: '+251911223344',
                  first_name: user.firstName,
                  user_id: user.id,
                },
              })
            }
            className="px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-[#159447] to-[#08743A] text-white text-[11px] font-extrabold flex items-center gap-1 hover:brightness-105"
          >
            <CheckCircle2 size={12} />
            {lang === 'am'
              ? '📲 ስልክ ቁጥርዎን ያጋሩ (Authentic Contact)'
              : '📲 Share Authentic Contact (Owner Match)'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() =>
              sendBotCommand('', {
                contact: {
                  phone_number: '+251999887766',
                  first_name: 'ForwardedUser',
                  user_id: 9999999,
                },
              })
            }
            className="px-2.5 py-1.5 rounded-lg bg-white border border-[#E7EDE8] text-[#183326] text-[11px] font-extrabold hover:bg-[#E6F6EB]"
          >
            {lang === 'am'
              ? '🚫 የሌላ ሰው ስልክ ሞክር (Spoof Test)'
              : '🚫 Test Forwarded Contact (Reject)'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => sendBotCommand('+251911223344')}
            className="px-2.5 py-1.5 rounded-lg bg-white border border-[#E7EDE8] text-[#183326] text-[11px] font-extrabold hover:bg-[#E6F6EB]"
          >
            {lang === 'am'
              ? '🚫 በጽሁፍ ስልክ ሞክር (Plain-Text Reject)'
              : '🚫 Test Plain-Text Phone (Reject)'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => sendBotCommand('/start', { overrideUid: 'attacker_different_uid' })}
            className="px-2.5 py-1.5 rounded-lg bg-white border border-[#E7EDE8] text-[#183326] text-[11px] font-extrabold hover:bg-[#E6F6EB]"
          >
            {lang === 'am'
              ? '🚫 ድጋሚ መለያ ሞክር (Duplicate Block)'
              : '🚫 Test Duplicate TG Account (Block)'}
          </button>
        </div>
      </div>

      {/* Live Bot Response Bubble + Dynamic Contextual Inline Keyboard */}
      {botReply && (
        <div className="space-y-1.5">
          <div className="p-2.5 rounded-xl bg-[#FFF9ED] border border-[#159447]/30 text-[#183326] space-y-1.5 font-sans">
            <div className="flex items-center justify-between text-[10.5px] text-[#08743A]">
              <span className="font-mono font-bold">
                @AdeyBingoGameBot · Chat #{botReply.chatId ?? user.id} ({(botReply.language || lang).toUpperCase()})
              </span>
              {botReply.securityCode && (
                <span className="px-1.5 py-0.5 rounded bg-[#FEF5DC] border border-[#F5BD42] font-mono text-[9.5px] font-bold text-[#9A6B0B]">
                  {botReply.securityCode}
                </span>
              )}
            </div>
            <pre className="whitespace-pre-wrap font-sans text-[11px] leading-snug m-0 text-[#183326]">
              {botReply.text}
            </pre>
            {callbackToast && (
              <div className="text-[10.5px] font-bold text-[#9A6B0B] bg-[#FEF5DC] border border-[#F5BD42] px-2 py-0.5 rounded">
                {callbackToast}
              </div>
            )}
          </div>

          {/* Dynamic Inline Keyboard Returned by @AdeyBingoGameBot */}
          {dynamicInlineRows.length > 0 && (
            <div data-testid="bot-dynamic-inline-keyboard" className="space-y-1 pl-0.5 pr-0.5">
              {dynamicInlineRows.map((row, rowIdx) => (
                <div
                  key={rowIdx}
                  className={`grid gap-1 ${
                    row.length === 1
                      ? 'grid-cols-1'
                      : row.length === 2
                      ? 'grid-cols-2'
                      : row.length === 3
                      ? 'grid-cols-3'
                      : 'grid-cols-4'
                  }`}
                >
                  {row.map((btn, colIdx) => (
                    <button
                      key={`${rowIdx}-${colIdx}-${btn.text}`}
                      type="button"
                      disabled={busy}
                      onClick={() => handleInlineButtonClick(btn)}
                      className={`px-2 py-1.5 rounded-lg text-[11px] font-extrabold flex items-center justify-center gap-1 transition-colors ${
                        btn.web_app
                          ? 'bg-gradient-to-r from-[#F5BD42] to-[#D99B20] text-[#183326] shadow-2xs'
                          : 'bg-[#E6F6EB] border border-[#159447]/30 text-[#08743A] hover:bg-[#159447] hover:text-white'
                      }`}
                    >
                      <span>{btn.text}</span>
                      {(btn.web_app || btn.url) && <ExternalLink size={11} />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 5-Row Amharic-First Main Menu Reply Keyboard (10 Buttons) */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <small className="text-[10.5px] font-bold text-[#68776D]">
            {lang === 'am'
              ? 'የቦት ዋና ሜኑ (Amharic-First 5-Row Main Menu — 10 Buttons):'
              : 'Bot 5-Row Main Menu Reply Keyboard (10 Buttons):'}
          </small>
          <span className="text-[9.5px] font-mono text-[#159447] truncate max-w-[180px]">
            {miniAppUrl}
          </span>
        </div>

        <div className="space-y-1" data-testid="bot-main-menu-keyboard">
          {activeMenuRows.map((row, rIdx) => (
            <div key={rIdx} className="grid grid-cols-2 gap-1">
              {row.map((btn) => (
                <button
                  key={btn.label}
                  type="button"
                  disabled={busy}
                  onClick={() => sendBotCommand(btn.label)}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-extrabold flex items-center justify-center gap-1 transition-colors ${
                    btn.isPlay
                      ? 'bg-gradient-to-r from-[#159447] to-[#08743A] text-white shadow-2xs'
                      : 'bg-[#FFF9ED] border border-[#E7EDE8] text-[#183326] hover:border-[#159447]/40 hover:bg-[#E6F6EB]'
                  }`}
                >
                  <span>{btn.label}</span>
                  {btn.isPlay && <ExternalLink size={11} />}
                </button>
              ))}
            </div>
          ))}
        </div>

        <small className="text-[10.5px] font-bold text-[#68776D] block pt-0.5">
          {lang === 'am'
            ? 'ፈጣን የውስጥ ቁልፎች (Interactive Callback Shortcuts):'
            : 'Interactive Callback Shortcuts:'}
        </small>
        <div className="flex flex-wrap gap-1">
          {INLINE_CALLBACK_SHORTCUTS.map((cb) => (
            <button
              key={cb.callbackData}
              type="button"
              disabled={busy}
              data-testid={`bot-cb-${cb.callbackData}`}
              onClick={() =>
                sendBotCommand('', {
                  callbackData: cb.callbackData,
                  callbackQueryId: `cbq_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                })
              }
              className="px-2 py-1 rounded-lg bg-[#E6F6EB] border border-[#159447]/25 text-[#08743A] text-[11px] font-extrabold hover:bg-[#159447] hover:text-white transition-colors"
            >
              {lang === 'am' ? cb.labelAm : cb.labelEn}
            </button>
          ))}
        </div>
      </div>

      {/* Secure Notifications Dispatcher & Outbox */}
      <div className="pt-1.5 border-t border-[#E7EDE8] space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-extrabold text-[#183326] flex items-center gap-1">
            <BellRing size={12} className="text-[#159447]" />
            {lang === 'am'
              ? 'የቴሌግራም ማሳወቂያዎች (Secure Notifications — አማርኛ Default)'
              : 'Telegram Bot Notifications (Amharic Default)'}
          </span>
          <span className="text-[9.5px] font-mono font-bold text-[#68776D]">
            <Globe size={10} className="inline mr-1" />
            {lang === 'am' ? 'አማርኛ (Default)' : 'English'}
          </span>
        </div>

        <div className="flex flex-wrap gap-1">
          {NOTIFICATION_EVENTS.map((ev) => (
            <button
              key={ev.id}
              type="button"
              disabled={busy}
              onClick={() => triggerNotification(ev.id)}
              className="px-2 py-1 rounded-md bg-[#FFF9ED] border border-[#E7EDE8] text-[#08743A] text-[10.5px] font-bold flex items-center gap-1 hover:bg-[#E6F6EB]"
            >
              <Send size={10} />
              {lang === 'am' ? ev.labelAm : ev.labelEn}
            </button>
          ))}
        </div>

        {outbox.length > 0 && (
          <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
            {outbox.slice(0, 4).map((msg) => (
              <div
                key={msg.id}
                className="p-2 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-[11px] space-y-0.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-[#08743A] font-extrabold flex items-center gap-1">
                    <Sparkles size={11} className="text-[#D99B20]" />
                    {msg.title}
                  </strong>
                  <span className="text-[9.5px] font-mono text-[#68776D] shrink-0">
                    {msg.event}
                  </span>
                </div>
                <p className="text-[10.5px] text-[#183326] m-0 leading-snug">{msg.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
