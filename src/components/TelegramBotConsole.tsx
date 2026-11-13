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
import { Language } from '../types/bingo';
import { TelegramUserProfile } from '../utils/telegram';
import {
  BotNotificationMessage,
  DEFAULT_DEPLOYED_MINI_APP_URL,
  NotificationEventType,
  TelegramBotResponse,
} from '../utils/telegramBot';

interface TelegramBotConsoleProps {
  lang: Language;
  user: TelegramUserProfile;
  firebaseUid: string | null;
  onSyncLanguage: (nextLang: Language) => void;
  onPhoneVerifiedFromBot: (phone: string) => void;
}

const SLASH_COMMANDS = ['/start', '/help', '/language', '/support', '/terms'] as const;

const MENU_BUTTONS = [
  '🎮 Start Playing',
  '👤 My Profile',
  '💰 My Balance',
  '🎁 Invite Friends',
  '📞 Contact Support',
  '📜 Terms and Conditions',
  '🌐 Change Language',
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sendBotCommand('/start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendBotCommand(
    text: string,
    extra: {
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
      const resp = await fetch('/api/telegram/bot-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderTelegramId: user.id,
          firstName: user.firstName,
          lastName: user.lastName || '',
          username: user.username.replace(/^@/, ''),
          firebaseUid: extra.overrideUid || firebaseUid || `tg_uid_${user.id}`,
          text,
          contact: extra.contact ?? null,
        }),
      });
      const data = await resp.json();
      setBotReply(data);
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
      const resp = await fetch('/api/telegram/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  return (
    <div className="bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#12a566] flex items-center gap-1">
            <Bot size={13} />
            {lang === 'am'
              ? 'MILESTONE 3 · የቴሌግራም ቦት እና ሚኒ አፕ ማዕከል'
              : 'MILESTONE 3 · TELEGRAM BOT & MINI APP INTEGRATION'}
          </span>
          <h3 className="font-['Outfit'] text-lg font-extrabold text-[#193b2b]">
            {lang === 'am'
              ? 'የቴሌግራም ቦት ትዕዛዞች፣ የስልክ ማረጋገጫ እና ማሳወቂያዎች'
              : 'Telegram Bot Commands, Contact Verification & Notifications'}
          </h3>
        </div>
        <span
          className={`text-[11px] font-extrabold px-2.5 py-1 rounded-lg flex items-center gap-1 ${
            botReply?.registrationStatus === 'verified'
              ? 'bg-[#e7f8ed] text-[#087e50]'
              : botReply?.registrationStatus === 'duplicate_blocked'
              ? 'bg-red-50 text-red-700'
              : 'bg-[#fef5dc] text-[#8a6109]'
          }`}
        >
          {botReply?.registrationStatus === 'verified' ? (
            <>
              <ShieldCheck size={13} />
              {lang === 'am' ? 'ስልክ እና መለያ ተረጋግጧል' : 'Bot Contact Verified'}
            </>
          ) : botReply?.registrationStatus === 'duplicate_blocked' ? (
            <>
              <ShieldAlert size={13} />
              {lang === 'am' ? 'ድጋሚ ምዝገባ ተከልክሏል' : 'Duplicate Blocked'}
            </>
          ) : (
            <>
              <PhoneCall size={13} />
              {lang === 'am' ? 'ስልክ ማጋራት ይጠበቃል' : 'Awaiting Contact Share'}
            </>
          )}
        </span>
      </div>

      {/* Part B: Slash Commands (/start, /help, /language, /support, /terms) */}
      <div className="space-y-1.5">
        <small className="text-[11px] font-bold text-[#486655] block">
          {lang === 'am'
            ? 'የቦት ትዕዛዞች (Part B — Bot Commands):'
            : 'Bot Slash Commands (Part B):'}
        </small>
        <div className="flex flex-wrap gap-1.5">
          {SLASH_COMMANDS.map((cmd) => (
            <button
              key={cmd}
              type="button"
              disabled={busy}
              onClick={() => sendBotCommand(cmd)}
              className="px-3 py-1.5 rounded-xl bg-[#f2faf5] border border-[#d5eadc] text-[#087e50] font-mono text-xs font-extrabold hover:bg-[#e3f5ea]"
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>

      {/* Part C: User Registration & Contact Ownership Verification Controls */}
      <div className="p-3.5 rounded-2xl bg-[#f6fbf8] border border-[#dcece1] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-extrabold text-[#193b2b] flex items-center gap-1.5">
            <PhoneCall size={14} className="text-[#087e50]" />
            {lang === 'am'
              ? 'የስልክ ባለቤትነት ማረጋገጫ (Part C — Contact Ownership Check)'
              : 'Telegram Contact Ownership & Anti-Spoof Tests (Part C)'}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
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
            className="px-3 py-2 rounded-xl bg-[#087e50] text-white text-xs font-extrabold flex items-center gap-1.5 hover:brightness-105"
          >
            <CheckCircle2 size={14} />
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
            className="px-3 py-2 rounded-xl bg-white border border-[#dce8df] text-[#355644] text-xs font-extrabold hover:bg-[#eef6f1]"
          >
            {lang === 'am'
              ? '🚫 የሌላ ሰው ስልክ ሞክር (Spoof Test)'
              : '🚫 Test Forwarded Contact (Reject)'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => sendBotCommand('+251911223344')}
            className="px-3 py-2 rounded-xl bg-white border border-[#dce8df] text-[#355644] text-xs font-extrabold hover:bg-[#eef6f1]"
          >
            {lang === 'am'
              ? '🚫 በጽሁፍ ስልክ ሞክር (Plain-Text Reject)'
              : '🚫 Test Plain-Text Phone (Reject)'}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => sendBotCommand('/start', { overrideUid: 'attacker_different_uid' })}
            className="px-3 py-2 rounded-xl bg-white border border-[#dce8df] text-[#355644] text-xs font-extrabold hover:bg-[#eef6f1]"
          >
            {lang === 'am'
              ? '🚫 ድጋሚ መለያ ሞክር (Duplicate Block)'
              : '🚫 Test Duplicate TG Account (Block)'}
          </button>
        </div>
      </div>

      {/* Live Bot Response Bubble */}
      {botReply && (
        <div className="p-4 rounded-2xl bg-[#132e21] text-[#eaf7f0] space-y-2.5 font-sans">
          <div className="flex items-center justify-between text-[11px] text-[#8fd9b0]">
            <span className="font-mono font-bold">
              @AdeyBingoBot · Chat #{botReply.chatId} ({botReply.language.toUpperCase()})
            </span>
            {botReply.securityCode && (
              <span className="px-2 py-0.5 rounded bg-white/10 font-mono text-[10px] text-[#fde047]">
                {botReply.securityCode}
              </span>
            )}
          </div>
          <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed m-0 text-white">
            {botReply.text}
          </pre>
        </div>
      )}

      {/* Part D: Mini App Launch Reply Keyboard (7 Required Buttons) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <small className="text-[11px] font-bold text-[#486655]">
            {lang === 'am'
              ? 'የቦት ዋና ሜኑ እና ሚኒ አፕ ማስጀመሪያ (Part D — 7 Bot Menu Buttons):'
              : 'Bot Reply Keyboard & Mini App Launcher (Part D):'}
          </small>
          <span className="text-[10px] font-mono text-[#087e50] truncate max-w-[210px]">
            {miniAppUrl}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {MENU_BUTTONS.map((btnLabel) => {
            const isStart = btnLabel === '🎮 Start Playing';
            return (
              <button
                key={btnLabel}
                type="button"
                disabled={busy}
                onClick={() => sendBotCommand(btnLabel)}
                className={`px-3 py-2 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1 transition-colors ${
                  isStart
                    ? 'col-span-2 bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white shadow-xs'
                    : 'bg-[#f4faf6] border border-[#dcece1] text-[#1e4230] hover:bg-[#e7f5ec]'
                }`}
              >
                <span>{btnLabel}</span>
                {isStart && <ExternalLink size={12} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Part E: Secure Notifications Dispatcher & Outbox */}
      <div className="pt-2 border-t border-[#e8f1eb] space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-extrabold text-[#193b2b] flex items-center gap-1.5">
            <BellRing size={14} className="text-[#087e50]" />
            {lang === 'am'
              ? 'የቴሌግራም ማሳወቂያዎች (Part E — Secure Notifications)'
              : 'Telegram Bot Notifications (Part E — Amharic Default)'}
          </span>
          <span className="text-[10px] font-mono font-bold text-[#5c7868]">
            <Globe size={11} className="inline mr-1" />
            {lang === 'am' ? 'አማርኛ (Default)' : 'English'}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {NOTIFICATION_EVENTS.map((ev) => (
            <button
              key={ev.id}
              type="button"
              disabled={busy}
              onClick={() => triggerNotification(ev.id)}
              className="px-2.5 py-1.5 rounded-lg bg-[#eff8f3] border border-[#d6eadf] text-[#087e50] text-[11px] font-bold flex items-center gap-1 hover:bg-[#dff2e7]"
            >
              <Send size={11} />
              {lang === 'am' ? ev.labelAm : ev.labelEn}
            </button>
          ))}
        </div>

        {outbox.length > 0 && (
          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {outbox.slice(0, 4).map((msg) => (
              <div
                key={msg.id}
                className="p-2.5 rounded-xl bg-[#f9fcfa] border border-[#e3eee7] text-xs space-y-0.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-[#087e50] font-extrabold flex items-center gap-1">
                    <Sparkles size={12} />
                    {msg.title}
                  </strong>
                  <span className="text-[10px] font-mono text-[#768d7f] shrink-0">
                    {msg.event}
                  </span>
                </div>
                <p className="text-[11px] text-[#3d5c4a] m-0 leading-relaxed">{msg.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
