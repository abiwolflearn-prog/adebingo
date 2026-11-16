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
    <div className="space-y-4">
      {/* Page Heading */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-[#E7EDE8] rounded-2xl p-4 sm:p-5 shadow-[0_6px_20px_rgba(24,51,38,0.06)]">
        <div>
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-[#159447]">
            ADEYBINGO · DEMO WALLET
          </span>
          <h1 className="font-['Outfit'] text-2xl sm:text-3xl font-extrabold text-[#183326] mt-0.5">
            {copy.walletHeading}
          </h1>
          <p className="text-xs text-[#68776D] mt-0.5">{copy.walletSubheading}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SecondaryButton
            size="sm"
            onClick={() => onNavigate('referral')}
            icon={<Gift size={14} className="text-[#D99B20]" />}
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
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* Card 1: Clean White Balance Card with Emerald Highlights */}
        <section className="lg:col-span-6 rounded-2xl bg-white border border-[#E7EDE8] p-5 flex flex-col justify-between shadow-[0_8px_24px_rgba(24,51,38,0.06)]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#159447] block">
                {copy.availableBalanceTitle}
              </span>
              <b
                data-testid="wallet-demo-balance"
                className="font-['Outfit'] text-3xl sm:text-4xl font-extrabold text-[#183326] tabular-nums block mt-2"
              >
                {demoBalance.toFixed(2)}{' '}
                <span className="text-lg font-bold text-[#159447]">ETB</span>
              </b>
              <p className="text-xs text-[#68776D] mt-1 font-medium">
                {lang === 'am'
                  ? 'ለካርድ ግዢ እና ለቀጥታ ጨዋታ ዝግጁ የሆነ ቀሪ ሂሳብ'
                  : 'Ready for Bingo card reservations and live rounds'}
              </p>
            </div>
            <span className="w-12 h-12 rounded-2xl bg-[#E6F6EB] border border-[#159447]/25 flex items-center justify-center text-[#159447] shrink-0 shadow-2xs">
              <Wallet size={22} />
            </span>
          </div>

          <div className="pt-5">
            <PrimaryButton
              variant="emerald"
              fullWidth
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'deposit' ? 'none' : 'deposit'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              icon={<ArrowDownLeft size={16} />}
            >
              {copy.depositBtn}
            </PrimaryButton>
          </div>
        </section>

        {/* Card 2: Warm Gold Accented Winnings & Rewards Card */}
        <section className="lg:col-span-6 rounded-2xl bg-gradient-to-br from-[#FEF5DC] via-[#FFF9ED] to-white border-2 border-[#F5BD42]/70 p-5 flex flex-col justify-between shadow-[0_8px_24px_rgba(217,155,32,0.12)]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#9A6B0B] block">
                {copy.winningsBalanceTitle}
              </span>
              <b
                data-testid="wallet-winnings-balance"
                className="font-['Outfit'] text-3xl sm:text-4xl font-extrabold text-[#183326] tabular-nums block mt-2"
              >
                {winningsBalance.toFixed(2)}{' '}
                <span className="text-lg font-bold text-[#D99B20]">ETB</span>
              </b>
              <p className="text-xs text-[#68776D] mt-1 font-medium">
                {lang === 'am'
                  ? 'ከተረጋገጡ የቢንጎ ድሎች የተገኘ ጠቅላላ ሽልማት'
                  : 'Verified cumulative Bingo round winnings & rewards'}
              </p>
            </div>
            <span className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#F5BD42] to-[#D99B20] flex items-center justify-center text-[#183326] shrink-0 shadow-[0_4px_12px_rgba(245,189,66,0.35)]">
              <Trophy size={22} />
            </span>
          </div>

          <div className="pt-5">
            <PrimaryButton
              variant="gold"
              fullWidth
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'withdraw' ? 'none' : 'withdraw'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              icon={<ArrowUpRight size={16} />}
            >
              {copy.withdrawBtn}
            </PrimaryButton>
          </div>
        </section>
      </div>

      {/* Sandbox Notice Banner */}
      <div className="rounded-2xl bg-[#FFF9ED] border border-[#F5BD42]/60 px-4 py-3 flex items-center gap-3 text-xs text-[#183326]">
        <ShieldAlert size={18} className="text-[#D99B20] shrink-0" />
        <span className="font-medium">
          {lang === 'am'
            ? 'ማሳሰቢያ፦ ይህ የሙከራ (Demo Sandbox) ቦርሳ ነው። እውነተኛ የገንዘብ ክፍያ አይጠየቅም።'
            : 'Sandbox Notice: All wallet deposits, withdrawals, and prizes operate in Demo Sandbox mode — no real-money payments are charged.'}
        </span>
      </div>

      {/* Collapsible Deposit or Withdrawal Action Drawer */}
      {showDepositForm && (
        <form
          onSubmit={handleDepositSubmit}
          className="rounded-2xl bg-white border-2 border-[#159447]/40 p-5 space-y-4 shadow-[0_10px_28px_rgba(21,148,71,0.1)]"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-extrabold uppercase text-[#159447]">
                {lang === 'am' ? 'የሙከራ ተቀማጭ ጥያቄ' : 'DEMO DEPOSIT REQUEST'}
              </span>
              <h3 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                {lang === 'am' ? 'የሙከራ ሂሳብ ማስገቢያ' : 'Submit Demo Deposit Request'}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="w-8 h-8 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-extrabold text-[#68776D] hover:text-[#183326]"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#183326] mb-1.5">
                {lang === 'am' ? 'የክፍያ ዘዴ (Demo)' : 'Sandbox Method'}
              </label>
              <select
                value={depositProvider}
                onChange={(e) => setDepositProvider(e.target.value)}
                aria-label="Sandbox Payment Method"
                className="w-full px-3 py-2.5 rounded-xl border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] focus:outline-none focus:border-[#159447]"
              >
                {DEMO_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#183326] mb-1.5">
                {lang === 'am' ? 'መጠን (ETB)' : 'Amount (ETB)'}
              </label>
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                aria-label="Demo deposit amount in ETB"
                className="w-full px-3 py-2.5 rounded-xl border border-[#E7EDE8] bg-[#FFF9ED] text-sm font-bold text-[#183326] tabular-nums focus:outline-none focus:border-[#159447]"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {[50, 100, 200, 500].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setDepositAmount(String(amt))}
                className={`px-3.5 py-2 rounded-xl text-xs font-extrabold tabular-nums border transition-colors ${
                  depositAmount === String(amt)
                    ? 'bg-[#159447] border-[#08743A] text-white'
                    : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#183326] hover:bg-[#E6F6EB]'
                }`}
              >
                +{amt} ETB
              </button>
            ))}
          </div>

          {depositError && <p className="text-xs font-bold text-[#D94B4B]">{depositError}</p>}

          <PrimaryButton type="submit" variant="emerald" fullWidth disabled={depositBusy}>
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
          className="rounded-2xl bg-white border-2 border-[#F5BD42] p-5 space-y-4 shadow-[0_10px_28px_rgba(217,155,32,0.12)]"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-extrabold uppercase text-[#9A6B0B]">
                {lang === 'am' ? 'የሙከራ ወጪ ጥያቄ' : 'DEMO WITHDRAWAL REQUEST'}
              </span>
              <h3 className="font-['Outfit'] text-lg font-extrabold text-[#183326]">
                {lang === 'am' ? 'የሙከራ ገንዘብ ማውጫ' : 'Submit Demo Withdrawal Request'}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="w-8 h-8 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs font-extrabold text-[#68776D] hover:text-[#183326]"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#183326] mb-1.5">
                {lang === 'am' ? 'መቀበያ ዘዴ (Demo)' : 'Payout Method (Demo)'}
              </label>
              <select
                value={withdrawProvider}
                onChange={(e) => setWithdrawProvider(e.target.value)}
                aria-label="Destination Method"
                className="w-full px-3 py-2.5 rounded-xl border border-[#E7EDE8] bg-[#FFF9ED] text-xs font-bold text-[#183326] focus:outline-none focus:border-[#D99B20]"
              >
                {DEMO_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#183326] mb-1.5">
                {lang === 'am' ? 'የወጪ መጠን (ቢያንስ 20 ETB)' : 'Withdrawal Amount (Min 20 ETB)'}
              </label>
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                aria-label="Demo withdrawal amount in ETB"
                className="w-full px-3 py-2.5 rounded-xl border border-[#E7EDE8] bg-[#FFF9ED] text-sm font-bold text-[#183326] tabular-nums focus:outline-none focus:border-[#D99B20]"
              />
            </div>
          </div>

          {withdrawError && <p className="text-xs font-bold text-[#D94B4B]">{withdrawError}</p>}

          <PrimaryButton type="submit" variant="gold" fullWidth disabled={withdrawBusy}>
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
        <section className="rounded-2xl bg-white border border-[#E7EDE8] p-4 space-y-2.5 shadow-[0_6px_20px_rgba(24,51,38,0.06)]">
          <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#159447]">
            {copy.recentRequestsTitle}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {depositRequests.slice(0, 3).map((d) => (
              <div
                key={d.depositId}
                className="flex items-center justify-between p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs"
              >
                <div>
                  <b className="text-[#183326] block">
                    +{d.amountEtb.toFixed(2)} ETB · {d.provider}
                  </b>
                  <span className="font-mono text-[10px] text-[#68776D]">{d.referenceCode}</span>
                </div>
                <span className="px-2.5 py-0.5 rounded-md bg-[#E6F6EB] text-[#08743A] font-extrabold text-[10px]">
                  {d.status}
                </span>
              </div>
            ))}
            {payoutRequests.slice(0, 3).map((w) => (
              <div
                key={w.requestId}
                className="flex items-center justify-between p-3 rounded-xl bg-[#FFF9ED] border border-[#E7EDE8] text-xs"
              >
                <div>
                  <b className="text-[#9A6B0B] block">
                    -{w.requestedAmountEtb.toFixed(2)} ETB · {w.paymentMethod}
                  </b>
                  <span className="font-mono text-[10px] text-[#68776D]">{w.requestId}</span>
                </div>
                <span className="px-2.5 py-0.5 rounded-md bg-[#FEF5DC] text-[#9A6B0B] border border-[#F5BD42] font-extrabold text-[10px]">
                  {w.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Transaction History with Empty State */}
      <section className="rounded-2xl bg-white border border-[#E7EDE8] p-5 space-y-4 shadow-[0_8px_24px_rgba(24,51,38,0.06)]">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[10px] font-extrabold uppercase text-[#159447] flex items-center gap-1.5">
              <Receipt size={13} />
              {lang === 'am' ? 'የግብይት መዝገብ' : 'TRANSACTION LEDGER'}
            </span>
            <h3 className="font-['Outfit'] text-xl font-extrabold text-[#183326] mt-0.5">
              {copy.recentTransactionsTitle}
            </h3>
          </div>

          <span className="text-xs font-extrabold text-[#08743A] bg-[#E6F6EB] px-2.5 py-1 rounded-lg tabular-nums">
            {transactions.length} {lang === 'am' ? 'መዝገቦች' : 'entries'}
          </span>
        </div>

        {transactions.length === 0 ? (
          <EmptyState
            testId="wallet-empty-transactions"
            icon={<Receipt size={24} />}
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
                  className="py-3.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                        tx.type === 'bingo_win'
                          ? 'bg-[#FEF5DC] border-[#F5BD42] text-[#D99B20]'
                          : isPositive
                          ? 'bg-[#E6F6EB] border-[#159447]/30 text-[#159447]'
                          : 'bg-[#FFF9ED] border-[#E7EDE8] text-[#68776D]'
                      }`}
                    >
                      {isPositive ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
                    </span>
                    <div className="min-w-0">
                      <b className="block text-xs sm:text-sm font-extrabold text-[#183326] truncate">
                        {lang === 'am' ? tx.labelAm : tx.labelEn}
                      </b>
                      <div className="flex items-center gap-2 text-[11px] text-[#68776D] mt-0.5">
                        <span className="truncate">{tx.timestamp}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{tx.reference}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <b
                      className={`font-['Outfit'] text-sm font-extrabold tabular-nums block ${
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
                        <CheckCircle2 size={11} className="text-[#168A49]" />
                      ) : (
                        <Clock size={11} className="text-[#D99B20]" />
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
