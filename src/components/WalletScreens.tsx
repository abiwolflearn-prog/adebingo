import { useState } from 'react';
import {
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  ShieldAlert,
  CheckCircle2,
  Clock,
  Receipt,
  Trophy,
  Gift,
  CircleHelp,
} from 'lucide-react';
import {
  DepositRequestSummary,
  Language,
  PayoutRequestSummary,
  ScreenId,
  WalletTransaction,
} from '../types/bingo';
import { t } from '../utils/i18n';
import { EmptyState, GameStatusBadge, PrimaryButton, SecondaryButton } from './DesignSystem';

interface WalletScreensProps {
  mode: 'wallet' | 'deposit' | 'withdraw';
  lang: Language;
  demoBalance: number;
  winningsBalance: number;
  transactions: WalletTransaction[];
  depositRequests?: DepositRequestSummary[];
  payoutRequests?: PayoutRequestSummary[];
  onSubmitDepositRequest: (
    amount: number,
    provider: string,
    receiptReference: string,
    receiptProof: string
  ) => Promise<void>;
  onSubmitWithdrawRequest: (amount: number, method: string) => Promise<boolean>;
  onNavigate: (screen: ScreenId) => void;
}

const MANUAL_PAYMENT_METHODS = [
  {
    id: 'Telebirr (Manual)',
    nameAm: 'ቴሌብር (Manual Transfer)',
    nameEn: 'Telebirr (Manual Transfer)',
    instructionAm: 'ወደ ADEYBINGO ቴሌብር ሂሳብ (+251 911 000 000) ከከፈሉ በኋላ የደረሰኝ ቁጥርዎን ከታች ያስገቡ።',
    instructionEn: 'Transfer manually via Telebirr (+251 911 000 000), then enter your receipt reference below.',
  },
  {
    id: 'CBE Birr (Manual)',
    nameAm: 'ሲቢኢ ብር (Manual Transfer)',
    nameEn: 'CBE Birr (Manual Transfer)',
    instructionAm: 'ወደ ADEYBINGO CBE Birr ሂሳብ (1000-0000-0000) ከከፈሉ በኋላ የደረሰኝ ቁጥርዎን ያስገቡ።',
    instructionEn: 'Transfer manually via CBE Birr (1000-0000-0000), then enter your receipt reference below.',
  },
  {
    id: 'Bank Transfer (Manual)',
    nameAm: 'የባንክ ዝውውር (Manual Transfer)',
    nameEn: 'Bank Transfer (Manual)',
    instructionAm: 'በባንክ ዝውውር (CBE 1000-0000-0000) ከከፈሉ በኋላ የዝውውር ማረጋገጫ ቁጥርዎን ያስገቡ።',
    instructionEn: 'Complete a manual bank transfer (CBE 1000-0000-0000), then submit your transfer receipt below.',
  },
];

export function WalletScreens({
  mode,
  lang,
  demoBalance,
  winningsBalance,
  transactions,
  depositRequests = [],
  payoutRequests = [],
  onSubmitDepositRequest,
  onSubmitWithdrawRequest,
  onNavigate,
}: WalletScreensProps) {
  const copy = t(lang);
  const [activeActionPanel, setActiveActionPanel] = useState<'none' | 'deposit' | 'withdraw'>(
    mode === 'deposit' ? 'deposit' : mode === 'withdraw' ? 'withdraw' : 'none'
  );

  const [depositAmount, setDepositAmount] = useState('100');
  const [depositProvider, setDepositProvider] = useState(MANUAL_PAYMENT_METHODS[0].id);
  const [depositReceiptRef, setDepositReceiptRef] = useState('');
  const [depositReceiptProof, setDepositReceiptProof] = useState('');
  const [depositError, setDepositError] = useState('');
  const [depositBusy, setDepositBusy] = useState(false);

  const [withdrawAmount, setWithdrawAmount] = useState('50');
  const [withdrawProvider, setWithdrawProvider] = useState(MANUAL_PAYMENT_METHODS[0].id);
  const [withdrawError, setWithdrawError] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);

  const showDepositForm = mode === 'deposit' || activeActionPanel === 'deposit';
  const showWithdrawForm = mode === 'withdraw' || activeActionPanel === 'withdraw';
  const activeMethodInfo =
    MANUAL_PAYMENT_METHODS.find((m) => m.id === depositProvider) ?? MANUAL_PAYMENT_METHODS[0];

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(depositAmount);
    if (!Number.isFinite(parsed) || parsed < 10 || parsed > 10000) {
      setDepositError(
        lang === 'am'
          ? 'ከ 10 እስከ 10,000 ETB መካከል ያለ መጠን ያስገቡ።'
          : 'Enter a valid amount between 10 and 10,000 ETB.'
      );
      return;
    }
    const cleanRef = depositReceiptRef.trim();
    if (cleanRef.length < 4) {
      setDepositError(
        lang === 'am'
          ? 'እባክዎ ትክክለኛ የክፍያ ደረሰኝ / ማረጋገጫ ቁጥር (ቢያንስ 4 ፊደል/ቁጥር) ያስገቡ።'
          : 'Please enter your payment receipt / transaction reference (at least 4 characters).'
      );
      return;
    }
    setDepositError('');
    setDepositBusy(true);
    try {
      await onSubmitDepositRequest(parsed, depositProvider, cleanRef, depositReceiptProof.trim());
      setDepositReceiptRef('');
      setDepositReceiptProof('');
      setActiveActionPanel('none');
      if (mode !== 'wallet') onNavigate('wallet');
    } catch (err) {
      setDepositError(err instanceof Error ? err.message : String(err));
    } finally {
      setDepositBusy(false);
    }
  };

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(withdrawAmount);
    if (!Number.isFinite(parsed) || parsed < 20) {
      setWithdrawError(
        lang === 'am'
          ? 'ዝቅተኛው የወጪ መጠን 20 ETB ነው።'
          : 'Minimum withdrawal request is 20 ETB.'
      );
      return;
    }
    if (parsed > demoBalance) {
      setWithdrawError(
        lang === 'am'
          ? 'በቂ የተረጋገጠ ቀሪ ሂሳብ የለዎትም።'
          : 'Insufficient verified balance.'
      );
      return;
    }
    setWithdrawError('');
    setWithdrawBusy(true);
    try {
      const ok = await onSubmitWithdrawRequest(parsed, withdrawProvider);
      if (ok) {
        setActiveActionPanel('none');
        if (mode !== 'wallet') onNavigate('wallet');
      }
    } finally {
      setWithdrawBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {/* Compact Icon-First Wallet Header */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 bg-white border border-[#E7EDE8] rounded-xl p-2 sm:p-2.5 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#E6F6EB] border border-[#159447]/25 flex items-center justify-center text-[#159447] shrink-0">
            <Wallet size={15} />
          </div>
          <h1 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326] leading-tight">
            {copy.walletHeading}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <SecondaryButton
            size="sm"
            onClick={() => onNavigate('referral')}
            title={lang === 'am' ? 'ጓደኛ ሲጋብዙ +20 ብር ቦነስ' : '+20 ETB bonus per invited friend'}
            icon={<Gift size={12} className="text-[#D99B20]" />}
            className="!bg-[#FEF5DC]/75 !border-[#F5BD42] !text-[#183326]"
          >
            {lang === 'am' ? '+20 ብር ግብዣ' : '+20 ETB Invite'}
          </SecondaryButton>

          <GameStatusBadge
            status="bonus"
            label={lang === 'am' ? 'የሙከራ (Demo)' : 'Demo Sandbox'}
            tooltip={
              lang === 'am'
                ? 'የሙከራ (Demo Sandbox) ቦርሳ — እውነተኛ የገንዘብ ክፍያ አይጠየቅም'
                : 'Demo Sandbox mode — no real-money payments are charged'
            }
          />
        </div>
      </div>

      {/* Clean 2-Column Compact Balance Cards: Available Balance | Winnings Balance */}
      <div className="grid grid-cols-2 gap-2 items-stretch">
        {/* Card 1: Playable Balance */}
        <section
          title={
            lang === 'am'
              ? 'ለካርድ ግዢ እና ለቀጥታ ጨዋታ ዝግጁ የሆነ ቀሪ ሂሳብ'
              : 'Ready for Bingo card reservations and live rounds'
          }
          className="rounded-xl bg-white border border-[#E7EDE8] p-2 sm:p-2.5 flex flex-col justify-between shadow-[0_2px_8px_rgba(24,51,38,0.04)]"
        >
          <div className="flex items-start justify-between gap-1">
            <div className="min-w-0">
              <span className="text-[9.5px] font-extrabold uppercase tracking-wider text-[#159447] flex items-center gap-1 truncate">
                {copy.availableBalanceTitle}
                <CircleHelp size={10} className="opacity-65 shrink-0" />
              </span>
              <b
                data-testid="wallet-demo-balance"
                className="font-['Outfit'] text-base sm:text-xl font-extrabold text-[#183326] tabular-nums block mt-0.5"
              >
                {demoBalance.toFixed(2)}{' '}
                <span className="text-[10px] sm:text-xs font-bold text-[#159447]">ETB</span>
              </b>
            </div>
            <span className="w-7 h-7 rounded-lg bg-[#E6F6EB] border border-[#159447]/25 flex items-center justify-center text-[#159447] shrink-0">
              <Wallet size={14} />
            </span>
          </div>

          <div className="pt-2">
            <PrimaryButton
              variant="emerald"
              size="sm"
              fullWidth
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'deposit' ? 'none' : 'deposit'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              icon={<ArrowDownLeft size={13} />}
            >
              {copy.depositBtn}
            </PrimaryButton>
          </div>
        </section>

        {/* Card 2: Winnings Balance */}
        <section
          title={
            lang === 'am'
              ? 'ከተረጋገጡ የቢንጎ ድሎች የተገኘ ጠቅላላ ሽልማት'
              : 'Verified cumulative Bingo round winnings & rewards'
          }
          className="rounded-xl bg-gradient-to-br from-[#FEF5DC] via-[#FFF9ED] to-white border border-[#F5BD42]/70 p-2 sm:p-2.5 flex flex-col justify-between shadow-[0_2px_8px_rgba(217,155,32,0.08)]"
        >
          <div className="flex items-start justify-between gap-1">
            <div className="min-w-0">
              <span className="text-[9.5px] font-extrabold uppercase tracking-wider text-[#9A6B0B] flex items-center gap-1 truncate">
                {copy.winningsBalanceTitle}
                <CircleHelp size={10} className="opacity-65 shrink-0" />
              </span>
              <b
                data-testid="wallet-winnings-balance"
                className="font-['Outfit'] text-base sm:text-xl font-extrabold text-[#183326] tabular-nums block mt-0.5"
              >
                {winningsBalance.toFixed(2)}{' '}
                <span className="text-[10px] sm:text-xs font-bold text-[#D99B20]">ETB</span>
              </b>
            </div>
            <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#F5BD42] to-[#D99B20] flex items-center justify-center text-[#183326] shrink-0 shadow-[0_2px_6px_rgba(245,189,66,0.25)]">
              <Trophy size={14} />
            </span>
          </div>

          <div className="pt-2">
            <PrimaryButton
              variant="gold"
              size="sm"
              fullWidth
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'withdraw' ? 'none' : 'withdraw'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              icon={<ArrowUpRight size={13} />}
            >
              {copy.withdrawBtn}
            </PrimaryButton>
          </div>
        </section>
      </div>

      {/* Compact Essential Sandbox Notice */}
      <div className="rounded-xl bg-[#FFF9ED] border border-[#F5BD42]/60 px-2.5 py-1.5 flex items-center gap-1.5 text-[10.5px] text-[#183326]">
        <ShieldAlert size={13} className="text-[#D99B20] shrink-0" />
        <span className="font-medium leading-tight">
          {lang === 'am'
            ? 'የሙከራ (Demo Sandbox) ቦርሳ — እውነተኛ የገንዘብ ክፍያ አይጠየቅም።'
            : 'Demo Sandbox Wallet — no real-money payments are charged.'}
        </span>
      </div>

      {/* Collapsible Deposit or Withdrawal Action Drawer */}
      {showDepositForm && (
        <form
          onSubmit={handleDepositSubmit}
          className="rounded-xl bg-white border-2 border-[#159447]/40 p-2.5 space-y-2 shadow-[0_3px_10px_rgba(21,148,71,0.08)]"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] flex items-center gap-1">
              <ArrowDownLeft size={14} className="text-[#159447]" />
              {lang === 'am' ? 'በእጅ የተከፈለ ገቢ ማረጋገጫ' : 'Manual Deposit & Receipt Submission'}
            </h3>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="w-6 h-6 rounded-md bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-extrabold text-[#68776D] hover:text-[#183326]"
            >
              ✕
            </button>
          </div>

          <div className="rounded-lg bg-[#FFF9ED] border border-[#F5BD42]/60 px-2 py-1.5 text-[10.5px] text-[#183326] leading-snug">
            <b className="text-[#08743A] block">
              {lang === 'am' ? 'የክፍያ መመሪያ (አስተዳዳሪ የሚያረጋግጠው)፦' : 'Manual Payment Instructions (Admin Verified):'}
            </b>
            <span>{lang === 'am' ? activeMethodInfo.instructionAm : activeMethodInfo.instructionEn}</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="block text-[10px] font-bold text-[#68776D] mb-0.5">
                {lang === 'am' ? 'ዘዴ' : 'Method'}
              </label>
              <select
                value={depositProvider}
                onChange={(e) => setDepositProvider(e.target.value)}
                aria-label="Manual Payment Method"
                className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-bold text-[#183326] min-h-[32px] focus:outline-none focus:border-[#159447]"
              >
                {MANUAL_PAYMENT_METHODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#68776D] mb-0.5">
                {lang === 'am' ? 'መጠን (ETB)' : 'Amount (ETB)'}
              </label>
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                aria-label="Deposit amount in ETB"
                className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-bold text-[#183326] tabular-nums min-h-[32px] focus:outline-none focus:border-[#159447]"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
            {[50, 100, 200, 500].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setDepositAmount(String(amt))}
                className={`px-2 py-0.5 rounded-md text-[10.5px] font-extrabold tabular-nums border transition-colors min-h-[28px] ${
                  depositAmount === String(amt)
                    ? 'bg-[#159447] border-[#08743A] text-white'
                    : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#183326] hover:bg-[#E6F6EB]'
                }`}
              >
                +{amt}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <div>
              <label className="block text-[10px] font-bold text-[#68776D] mb-0.5">
                {lang === 'am' ? 'የደረሰኝ / ትራንዛክሽን ቁጥር *' : 'Payment Receipt / Ref Code *'}
              </label>
              <input
                type="text"
                required
                value={depositReceiptRef}
                onChange={(e) => setDepositReceiptRef(e.target.value)}
                placeholder={lang === 'am' ? 'ምሳሌ፦ FT26109ABC' : 'e.g. FT26109ABC'}
                aria-label="Payment receipt reference code"
                className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-mono font-bold text-[#183326] min-h-[32px] focus:outline-none focus:border-[#159447]"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-[#68776D] mb-0.5">
                {lang === 'am' ? 'ተጨማሪ ማረጋገጫ (አማራጭ)' : 'Receipt Proof / Sender Note (Optional)'}
              </label>
              <input
                type="text"
                value={depositReceiptProof}
                onChange={(e) => setDepositReceiptProof(e.target.value)}
                placeholder={lang === 'am' ? 'የላኪ ስም / ስልክ / ማስታወሻ' : 'Sender name / SMS detail / receipt URL'}
                aria-label="Payment receipt proof note"
                className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-medium text-[#183326] min-h-[32px] focus:outline-none focus:border-[#159447]"
              />
            </div>
          </div>

          {depositError && <p className="text-[10.5px] font-bold text-[#D94B4B]">{depositError}</p>}

          <PrimaryButton type="submit" variant="emerald" size="sm" fullWidth disabled={depositBusy}>
            {depositBusy
              ? '...'
              : lang === 'am'
              ? `የ +${depositAmount || 0} ETB ደረሰኝ ላክ`
              : `Submit +${depositAmount || 0} ETB Receipt`}
          </PrimaryButton>
        </form>
      )}

      {showWithdrawForm && (
        <form
          onSubmit={handleWithdrawSubmit}
          className="rounded-xl bg-white border-2 border-[#F5BD42] p-2.5 space-y-2 shadow-[0_3px_10px_rgba(217,155,32,0.1)]"
        >
          <div className="flex items-center justify-between">
            <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] flex items-center gap-1">
              <ArrowUpRight size={14} className="text-[#D99B20]" />
              {lang === 'am' ? 'የሙከራ ወጪ (Demo Withdraw)' : 'Demo Withdrawal Request'}
            </h3>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="w-6 h-6 rounded-md bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-extrabold text-[#68776D] hover:text-[#183326]"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="block text-[10px] font-bold text-[#68776D] mb-0.5">
                {lang === 'am' ? 'ዘዴ' : 'Method'}
              </label>
              <select
                value={withdrawProvider}
                onChange={(e) => setWithdrawProvider(e.target.value)}
                aria-label="Destination Method"
                className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-bold text-[#183326] min-h-[32px] focus:outline-none focus:border-[#D99B20]"
              >
                {MANUAL_PAYMENT_METHODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-[#68776D] mb-0.5">
                {lang === 'am' ? 'መጠን (≥20 ETB)' : 'Amount (≥20 ETB)'}
              </label>
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                aria-label="Demo withdrawal amount in ETB"
                className="w-full px-2 py-1 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-[11px] font-bold text-[#183326] tabular-nums min-h-[32px] focus:outline-none focus:border-[#D99B20]"
              />
            </div>
          </div>

          {withdrawError && <p className="text-[10.5px] font-bold text-[#D94B4B]">{withdrawError}</p>}

          <PrimaryButton type="submit" variant="gold" size="sm" fullWidth disabled={withdrawBusy}>
            {withdrawBusy
              ? '...'
              : lang === 'am'
              ? `-${withdrawAmount || 0} ETB ላክ`
              : `Withdraw ${withdrawAmount || 0} ETB`}
          </PrimaryButton>
        </form>
      )}

      {/* Pending / Recent Deposit & Payout Confirmations */}
      {(depositRequests.length > 0 || payoutRequests.length > 0) && (
        <section className="rounded-xl bg-white border border-[#E7EDE8] p-2.5 space-y-1.5 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
          <h3 className="text-[10px] font-extrabold uppercase tracking-wider text-[#159447]">
            {copy.recentRequestsTitle}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
            {depositRequests.slice(0, 5).map((d) => (
              <div
                key={d.depositId}
                className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-[11px]"
              >
                <div className="min-w-0">
                  <b className="text-[#183326] block truncate">
                    +{d.amountEtb.toFixed(2)} ETB · {d.provider}
                  </b>
                  <span className="font-mono text-[9.5px] text-[#68776D] block truncate">
                    {d.referenceCode}
                  </span>
                  {d.reviewNotes && (
                    <span className="text-[9.5px] text-[#68776D] block truncate">
                      {d.reviewNotes}
                    </span>
                  )}
                </div>
                <span
                  className={`px-1.5 py-0.5 rounded font-extrabold text-[9.5px] shrink-0 ${
                    d.status === 'Rejected'
                      ? 'bg-[#FFF5F5] text-[#D94B4B] border border-[#D94B4B]/30'
                      : d.status === 'Pending'
                        ? 'bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42]/60'
                        : 'bg-[#E6F6EB] text-[#08743A]'
                  }`}
                >
                  {d.status}
                </span>
              </div>
            ))}
            {payoutRequests.slice(0, 3).map((w) => (
              <div
                key={w.requestId}
                className="flex items-center justify-between p-2 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-[11px]"
              >
                <div>
                  <b className="text-[#9A6B0B] block">
                    -{w.requestedAmountEtb.toFixed(2)} ETB · {w.paymentMethod}
                  </b>
                  <span className="font-mono text-[9.5px] text-[#68776D]">{w.requestId}</span>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42] font-extrabold text-[9.5px]">
                  {w.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Compact Transaction History Ledger */}
      <section className="rounded-xl bg-white border border-[#E7EDE8] p-2.5 sm:p-3 space-y-2 shadow-[0_2px_8px_rgba(24,51,38,0.04)]">
        <div className="flex items-center justify-between">
          <h3 className="font-['Outfit'] text-xs sm:text-sm font-extrabold text-[#183326] flex items-center gap-1.5">
            <Receipt size={14} className="text-[#159447]" />
            {copy.recentTransactionsTitle}
          </h3>

          <span className="text-[10px] font-extrabold text-[#08743A] bg-[#E6F6EB] px-2 py-0.5 rounded tabular-nums">
            {transactions.length}
          </span>
        </div>

        {transactions.length === 0 ? (
          <EmptyState
            testId="wallet-empty-transactions"
            icon={<Receipt size={18} />}
            title={copy.emptyTransactionsTitle}
            description={copy.emptyTransactionsDesc}
          />
        ) : (
          <div className="divide-y divide-[#E7EDE8]">
            {transactions.map((tx) => {
              const isPositive = tx.amount >= 0;
              return (
                <div
                  key={tx.id}
                  className="py-1.5 flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${
                        tx.type === 'bingo_win'
                          ? 'bg-[#FEF5DC] border-[#F5BD42] text-[#D99B20]'
                          : isPositive
                          ? 'bg-[#E6F6EB] border-[#159447]/30 text-[#159447]'
                          : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#68776D]'
                      }`}
                    >
                      {isPositive ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}
                    </span>
                    <div className="min-w-0">
                      <b className="block text-[11px] font-extrabold text-[#183326] truncate">
                        {lang === 'am' ? tx.labelAm : tx.labelEn}
                      </b>
                      <div className="flex items-center gap-1 text-[9.5px] text-[#68776D]">
                        <span className="truncate">{tx.timestamp}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{tx.reference}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <b
                      className={`font-['Outfit'] text-xs font-extrabold tabular-nums block ${
                        tx.type === 'bingo_win'
                          ? 'text-[#D99B20]'
                          : isPositive
                          ? 'text-[#168A49]'
                          : 'text-[#183326]'
                      }`}
                    >
                      {isPositive ? `+${tx.amount.toFixed(2)}` : tx.amount.toFixed(2)} ETB
                    </b>
                    <span className="inline-flex items-center gap-0.5 text-[9.5px] font-bold text-[#68776D]">
                      {tx.status === 'demo_completed' ? (
                        <CheckCircle2 size={9} className="text-[#168A49]" />
                      ) : (
                        <Clock size={9} className="text-[#D99B20]" />
                      )}
                      {lang === 'am' ? 'የተረጋገጠ' : 'Verified'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
