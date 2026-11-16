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
  onSubmitDepositRequest: (amount: number, provider: string) => Promise<void>;
  onSubmitWithdrawRequest: (amount: number, method: string) => Promise<boolean>;
  onNavigate: (screen: ScreenId) => void;
}

const DEMO_PROVIDERS = [
  { id: 'Telebirr (Demo)', nameAm: 'ቴሌብር (Telebirr Demo)', nameEn: 'Telebirr (Demo)' },
  { id: 'CBE Birr (Demo)', nameAm: 'ሲቢኢ ብር (CBE Birr Demo)', nameEn: 'CBE Birr (Demo)' },
  { id: 'Chapa Sandbox (Demo)', nameAm: 'ቻፓ ሳንድቦክስ (Chapa Demo)', nameEn: 'Chapa Sandbox (Demo)' },
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
  const [depositProvider, setDepositProvider] = useState(DEMO_PROVIDERS[0].id);
  const [depositError, setDepositError] = useState('');
  const [depositBusy, setDepositBusy] = useState(false);

  const [withdrawAmount, setWithdrawAmount] = useState('50');
  const [withdrawProvider, setWithdrawProvider] = useState(DEMO_PROVIDERS[0].id);
  const [withdrawError, setWithdrawError] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);

  const showDepositForm = mode === 'deposit' || activeActionPanel === 'deposit';
  const showWithdrawForm = mode === 'withdraw' || activeActionPanel === 'withdraw';

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(depositAmount);
    if (!Number.isFinite(parsed) || parsed < 10 || parsed > 10000) {
      setDepositError(
        lang === 'am'
          ? 'እባክዎ ከ 10 እስከ 10,000 ETB መካከል ያለ መጠን ያስገቡ።'
          : 'Please enter a valid demo request between 10 and 10,000 ETB.'
      );
      return;
    }
    setDepositError('');
    setDepositBusy(true);
    try {
      await onSubmitDepositRequest(parsed, depositProvider);
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
          ? 'ዝቅተኛው የሙከራ ወጪ መጠን 20 ETB ነው።'
          : 'Minimum demo withdrawal request is 20 ETB.'
      );
      return;
    }
    if (parsed > demoBalance) {
      setWithdrawError(
        lang === 'am'
          ? 'በቂ የተረጋገጠ ቀሪ ሂሳብ የለዎትም።'
          : 'Insufficient verified balance for this withdrawal.'
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
    <div className="space-y-2.5">
      {/* Page Heading */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-[#E7EDE8] rounded-xl p-2.5 sm:p-3.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
        <div>
          <span className="text-[9.5px] font-extrabold tracking-widest uppercase text-[#159447]">
            ADEYBINGO · DEMO WALLET
          </span>
          <h1 className="font-['Outfit'] text-lg sm:text-xl font-extrabold text-[#183326] leading-tight">
            {copy.walletHeading}
          </h1>
          <p className="text-[11px] text-[#68776D] mt-0.5">{copy.walletSubheading}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <SecondaryButton
            size="sm"
            onClick={() => onNavigate('referral')}
            icon={<Gift size={13} className="text-[#D99B20]" />}
            className="!bg-[#FEF5DC]/75 !border-[#F5BD42] !text-[#183326]"
          >
            {lang === 'am' ? 'ጓደኛ ይጋብዙ (+20 ብር)' : 'Invite Friends (+20 ETB)'}
          </SecondaryButton>

          <GameStatusBadge
            status="bonus"
            label={lang === 'am' ? 'የሙከራ ሁኔታ (Demo Sandbox)' : 'Demo Sandbox Only'}
          />
        </div>
      </div>

      {/* Clean 2-Column Balance Cards: Available Balance | Winnings Balance */}
      <div className="grid grid-cols-2 lg:grid-cols-12 gap-2 sm:gap-2.5 items-stretch">
        {/* Card 1: Clean White Balance Card with Emerald Highlights */}
        <section className="col-span-1 lg:col-span-6 rounded-xl bg-white border border-[#E7EDE8] p-2.5 sm:p-3.5 flex flex-col justify-between shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
          <div className="flex items-start justify-between gap-1.5">
            <div className="min-w-0">
              <span className="text-[9.5px] sm:text-[10.5px] font-extrabold uppercase tracking-wider text-[#159447] block truncate">
                {copy.availableBalanceTitle}
              </span>
              <b
                data-testid="wallet-demo-balance"
                className="font-['Outfit'] text-lg sm:text-2xl font-extrabold text-[#183326] tabular-nums block mt-0.5"
              >
                {demoBalance.toFixed(2)}{' '}
                <span className="text-xs sm:text-sm font-bold text-[#159447]">ETB</span>
              </b>
              <p className="text-[10px] sm:text-[11px] text-[#68776D] mt-0.5 font-medium leading-tight">
                {lang === 'am'
                  ? 'ለካርድ ግዢ እና ለቀጥታ ጨዋታ ዝግጁ የሆነ ቀሪ ሂሳብ'
                  : 'Ready for Bingo card reservations and live rounds'}
              </p>
            </div>
            <span className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-[#E6F6EB] border border-[#159447]/25 flex items-center justify-center text-[#159447] shrink-0 shadow-2xs">
              <Wallet size={16} />
            </span>
          </div>

          <div className="pt-2.5">
            <PrimaryButton
              variant="emerald"
              size="sm"
              fullWidth
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'deposit' ? 'none' : 'deposit'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              icon={<ArrowDownLeft size={14} />}
            >
              {copy.depositBtn}
            </PrimaryButton>
          </div>
        </section>

        {/* Card 2: Warm Gold Accented Winnings & Rewards Card */}
        <section className="col-span-1 lg:col-span-6 rounded-xl bg-gradient-to-br from-[#FEF5DC] via-[#FFF9ED] to-white border border-[#F5BD42]/70 p-2.5 sm:p-3.5 flex flex-col justify-between shadow-[0_3px_10px_rgba(217,155,32,0.1)]">
          <div className="flex items-start justify-between gap-1.5">
            <div className="min-w-0">
              <span className="text-[9.5px] sm:text-[10.5px] font-extrabold uppercase tracking-wider text-[#9A6B0B] block truncate">
                {copy.winningsBalanceTitle}
              </span>
              <b
                data-testid="wallet-winnings-balance"
                className="font-['Outfit'] text-lg sm:text-2xl font-extrabold text-[#183326] tabular-nums block mt-0.5"
              >
                {winningsBalance.toFixed(2)}{' '}
                <span className="text-xs sm:text-sm font-bold text-[#D99B20]">ETB</span>
              </b>
              <p className="text-[10px] sm:text-[11px] text-[#68776D] mt-0.5 font-medium leading-tight">
                {lang === 'am'
                  ? 'ከተረጋገጡ የቢንጎ ድሎች የተገኘ ጠቅላላ ሽልማት'
                  : 'Verified cumulative Bingo round winnings & rewards'}
              </p>
            </div>
            <span className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-gradient-to-br from-[#F5BD42] to-[#D99B20] flex items-center justify-center text-[#183326] shrink-0 shadow-[0_3px_8px_rgba(245,189,66,0.3)]">
              <Trophy size={16} />
            </span>
          </div>

          <div className="pt-2.5">
            <PrimaryButton
              variant="gold"
              size="sm"
              fullWidth
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'withdraw' ? 'none' : 'withdraw'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              icon={<ArrowUpRight size={14} />}
            >
              {copy.withdrawBtn}
            </PrimaryButton>
          </div>
        </section>
      </div>

      {/* Sandbox Notice Banner */}
      <div className="rounded-xl bg-[#FFF9ED] border border-[#F5BD42]/60 px-3 py-2 flex items-center gap-2 text-[11px] text-[#183326]">
        <ShieldAlert size={14} className="text-[#D99B20] shrink-0" />
        <span className="font-medium leading-tight">
          {lang === 'am'
            ? 'ማሳሰቢያ፦ ይህ የሙከራ (Demo Sandbox) ቦርሳ ነው። እውነተኛ የገንዘብ ክፍያ አይጠየቅም።'
            : 'Sandbox Notice: All wallet deposits, withdrawals, and prizes operate in Demo Sandbox mode — no real-money payments are charged.'}
        </span>
      </div>

      {/* Collapsible Deposit or Withdrawal Action Drawer */}
      {showDepositForm && (
        <form
          onSubmit={handleDepositSubmit}
          className="rounded-xl bg-white border-2 border-[#159447]/40 p-3 space-y-2.5 shadow-[0_4px_14px_rgba(21,148,71,0.08)]"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[9.5px] font-extrabold uppercase text-[#159447]">
                {lang === 'am' ? 'የሙከራ ተቀማጭ ጥያቄ' : 'DEMO DEPOSIT REQUEST'}
              </span>
              <h3 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326]">
                {lang === 'am' ? 'የሙከራ ሂሳብ ማስገቢያ' : 'Submit Demo Deposit Request'}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="w-7 h-7 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-extrabold text-[#68776D] hover:text-[#183326]"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-bold text-[#183326] mb-1">
                {lang === 'am' ? 'የክፍያ ዘዴ (Demo)' : 'Sandbox Method'}
              </label>
              <select
                value={depositProvider}
                onChange={(e) => setDepositProvider(e.target.value)}
                aria-label="Sandbox Payment Method"
                className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] min-h-[34px] focus:outline-none focus:border-[#159447]"
              >
                {DEMO_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-bold text-[#183326] mb-1">
                {lang === 'am' ? 'መጠን (ETB)' : 'Amount (ETB)'}
              </label>
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                aria-label="Demo deposit amount in ETB"
                className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] tabular-nums min-h-[34px] focus:outline-none focus:border-[#159447]"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {[50, 100, 200, 500].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setDepositAmount(String(amt))}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-extrabold tabular-nums border transition-colors min-h-[32px] ${
                  depositAmount === String(amt)
                    ? 'bg-[#159447] border-[#08743A] text-white'
                    : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#183326] hover:bg-[#E6F6EB]'
                }`}
              >
                +{amt} ETB
              </button>
            ))}
          </div>

          {depositError && <p className="text-[11px] font-bold text-[#D94B4B]">{depositError}</p>}

          <PrimaryButton type="submit" variant="emerald" size="sm" fullWidth disabled={depositBusy}>
            {depositBusy
              ? '...'
              : lang === 'am'
              ? `${depositAmount || 0} ETB የተቀማጭ ጥያቄ ላክ`
              : `Submit ${depositAmount || 0} ETB Deposit Request`}
          </PrimaryButton>
        </form>
      )}

      {showWithdrawForm && (
        <form
          onSubmit={handleWithdrawSubmit}
          className="rounded-xl bg-white border-2 border-[#F5BD42] p-3 space-y-2.5 shadow-[0_4px_14px_rgba(217,155,32,0.1)]"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[9.5px] font-extrabold uppercase text-[#9A6B0B]">
                {lang === 'am' ? 'የሙከራ ወጪ ጥያቄ' : 'DEMO WITHDRAWAL REQUEST'}
              </span>
              <h3 className="font-['Outfit'] text-sm sm:text-base font-extrabold text-[#183326]">
                {lang === 'am' ? 'የሙከራ ገንዘብ ማውጫ' : 'Submit Demo Withdrawal Request'}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="w-7 h-7 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-extrabold text-[#68776D] hover:text-[#183326]"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-bold text-[#183326] mb-1">
                {lang === 'am' ? 'መቀበያ ዘዴ (Demo)' : 'Payout Method (Demo)'}
              </label>
              <select
                value={withdrawProvider}
                onChange={(e) => setWithdrawProvider(e.target.value)}
                aria-label="Destination Method"
                className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] min-h-[34px] focus:outline-none focus:border-[#D99B20]"
              >
                {DEMO_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-bold text-[#183326] mb-1">
                {lang === 'am' ? 'የወጪ መጠን (ቢያንስ 20 ETB)' : 'Withdrawal Amount (Min 20 ETB)'}
              </label>
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                aria-label="Demo withdrawal amount in ETB"
                className="w-full px-2.5 py-1.5 rounded-lg border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] tabular-nums min-h-[34px] focus:outline-none focus:border-[#D99B20]"
              />
            </div>
          </div>

          {withdrawError && <p className="text-[11px] font-bold text-[#D94B4B]">{withdrawError}</p>}

          <PrimaryButton type="submit" variant="gold" size="sm" fullWidth disabled={withdrawBusy}>
            {withdrawBusy
              ? '...'
              : lang === 'am'
              ? 'የሙከራ ወጪ ጥያቄ ላክ'
              : 'Submit Demo Withdrawal Request'}
          </PrimaryButton>
        </form>
      )}

      {/* Pending / Recent Deposit & Payout Requests */}
      {(depositRequests.length > 0 || payoutRequests.length > 0) && (
        <section className="rounded-xl bg-white border border-[#E7EDE8] p-3 space-y-2 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
          <h3 className="text-[11px] font-extrabold uppercase tracking-wider text-[#159447]">
            {copy.recentRequestsTitle}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {depositRequests.slice(0, 3).map((d) => (
              <div
                key={d.depositId}
                className="flex items-center justify-between p-2.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-xs"
              >
                <div>
                  <b className="text-[#183326] block">
                    +{d.amountEtb.toFixed(2)} ETB · {d.provider}
                  </b>
                  <span className="font-mono text-[10px] text-[#68776D]">{d.referenceCode}</span>
                </div>
                <span className="px-2 py-0.5 rounded bg-[#E6F6EB] text-[#08743A] font-extrabold text-[10px]">
                  {d.status}
                </span>
              </div>
            ))}
            {payoutRequests.slice(0, 3).map((w) => (
              <div
                key={w.requestId}
                className="flex items-center justify-between p-2.5 rounded-lg bg-[#FFF9ED] border border-[#E7EDE8] text-xs"
              >
                <div>
                  <b className="text-[#9A6B0B] block">
                    -{w.requestedAmountEtb.toFixed(2)} ETB · {w.paymentMethod}
                  </b>
                  <span className="font-mono text-[10px] text-[#68776D]">{w.requestId}</span>
                </div>
                <span className="px-2 py-0.5 rounded bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42] font-extrabold text-[10px]">
                  {w.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Transaction History with Empty State */}
      <section className="rounded-xl bg-white border border-[#E7EDE8] p-3 sm:p-3.5 space-y-2.5 shadow-[0_3px_10px_rgba(24,51,38,0.05)]">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[9.5px] font-extrabold uppercase text-[#159447] flex items-center gap-1">
              <Receipt size={12} />
              {lang === 'am' ? 'የግብይት መዝገብ' : 'TRANSACTION LEDGER'}
            </span>
            <h3 className="font-['Outfit'] text-base sm:text-lg font-extrabold text-[#183326]">
              {copy.recentTransactionsTitle}
            </h3>
          </div>

          <span className="text-[11px] font-extrabold text-[#08743A] bg-[#E6F6EB] px-2 py-0.5 rounded-md tabular-nums">
            {transactions.length} {lang === 'am' ? 'መዝገቦች' : 'entries'}
          </span>
        </div>

        {transactions.length === 0 ? (
          <EmptyState
            testId="wallet-empty-transactions"
            icon={<Receipt size={20} />}
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
                  className="py-2 flex items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                        tx.type === 'bingo_win'
                          ? 'bg-[#FEF5DC] border-[#F5BD42] text-[#D99B20]'
                          : isPositive
                          ? 'bg-[#E6F6EB] border-[#159447]/30 text-[#159447]'
                          : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#68776D]'
                      }`}
                    >
                      {isPositive ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                    </span>
                    <div className="min-w-0">
                      <b className="block text-xs font-extrabold text-[#183326] truncate">
                        {lang === 'am' ? tx.labelAm : tx.labelEn}
                      </b>
                      <div className="flex items-center gap-1.5 text-[10px] text-[#68776D]">
                        <span className="truncate">{tx.timestamp}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{tx.reference}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <b
                      className={`font-['Outfit'] text-xs sm:text-sm font-extrabold tabular-nums block ${
                        tx.type === 'bingo_win'
                          ? 'text-[#D99B20]'
                          : isPositive
                          ? 'text-[#168A49]'
                          : 'text-[#183326]'
                      }`}
                    >
                      {isPositive ? `+${tx.amount.toFixed(2)}` : tx.amount.toFixed(2)} ETB
                    </b>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#68776D]">
                      {tx.status === 'demo_completed' ? (
                        <CheckCircle2 size={10} className="text-[#168A49]" />
                      ) : (
                        <Clock size={10} className="text-[#D99B20]" />
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
