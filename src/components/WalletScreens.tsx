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
  TicketPercent,
  Sparkles,
  Copy,
  Check,
} from 'lucide-react';
import {
  DepositRequestSummary,
  Language,
  PayoutRequestSummary,
  ScreenId,
  WalletTransaction,
} from '../types/bingo';
import { t } from '../utils/i18n';

interface WalletScreensProps {
  mode: 'wallet' | 'deposit' | 'withdraw';
  lang: Language;
  demoBalance: number;
  winningsBalance: number;
  referralCode?: string;
  referredByCode?: string;
  transactions: WalletTransaction[];
  depositRequests?: DepositRequestSummary[];
  payoutRequests?: PayoutRequestSummary[];
  onApplyPromoCode: (code: string) => Promise<{ ok: boolean; message: string }>;
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
  referralCode,
  referredByCode,
  transactions,
  depositRequests = [],
  payoutRequests = [],
  onApplyPromoCode,
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

  const [promoCodeInput, setPromoCodeInput] = useState('');
  const [promoFeedback, setPromoFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const showDepositForm = mode === 'deposit' || activeActionPanel === 'deposit';
  const showWithdrawForm = mode === 'withdraw' || activeActionPanel === 'withdraw';

  const handleCopyRefCode = async () => {
    if (!referralCode) return;
    try {
      await navigator.clipboard?.writeText(referralCode);
    } catch {
      // Ignore clipboard failures inside restricted WebViews
    }
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  };

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

  const handlePromoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = promoCodeInput.trim();
    if (cleaned.length < 3) {
      setPromoFeedback({
        ok: false,
        text:
          lang === 'am'
            ? 'እባክዎ ትክክለኛ የፕሮሞ ወይም የግብዣ ኮድ ያስገቡ።'
            : 'Please enter a valid promo or referral code.',
      });
      return;
    }
    setPromoBusy(true);
    setPromoFeedback(null);
    try {
      const res = await onApplyPromoCode(cleaned);
      setPromoFeedback({ ok: res.ok, text: res.message });
      if (res.ok) setPromoCodeInput('');
    } finally {
      setPromoBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Page Heading */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-[10px] font-extrabold tracking-widest uppercase text-[#22d3ee]">
            ADEYBINGO · DEMO WALLET
          </span>
          <h1 className="font-['Outfit'] text-2xl sm:text-3xl font-extrabold text-white mt-0.5">
            {copy.walletHeading}
          </h1>
          <p className="text-xs text-[#94a3b8] mt-0.5">{copy.walletSubheading}</p>
        </div>

        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#f59e0b]/15 border border-[#f59e0b]/35 text-[#fde047] text-[11px] font-bold">
          <ShieldAlert size={14} />
          {lang === 'am' ? 'የሙከራ ሁኔታ (Demo Sandbox)' : 'Demo Sandbox Only'}
        </span>
      </div>

      {/* 3 Distinct Treatment Cards: Available Balance | Promo/Referral | Winnings Balance */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* Card 1: Available Balance (Deep Navy + Cyan Highlight) */}
        <section className="lg:col-span-4 rounded-2xl bg-gradient-to-br from-[#0e1f3a] via-[#102646] to-[#0c1c33] border border-[#22d3ee]/35 p-5 flex flex-col justify-between shadow-[0_12px_32px_rgba(2,6,23,0.45)]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#67e8f9] block">
                {copy.availableBalanceTitle}
              </span>
              <b
                data-testid="wallet-demo-balance"
                className="font-['Outfit'] text-3xl sm:text-4xl font-extrabold text-white tabular-nums block mt-2"
              >
                {demoBalance.toFixed(2)}{' '}
                <span className="text-lg font-bold text-[#22d3ee]">ETB</span>
              </b>
            </div>
            <span className="w-11 h-11 rounded-2xl bg-[#22d3ee]/15 border border-[#22d3ee]/35 flex items-center justify-center text-[#22d3ee] shrink-0">
              <Wallet size={22} />
            </span>
          </div>

          <div className="pt-5">
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'deposit' ? 'none' : 'deposit'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#22d3ee] to-[#06b6d4] text-[#041423] text-xs font-extrabold flex items-center justify-center gap-2 shadow-[0_6px_20px_rgba(34,211,238,0.28)] hover:brightness-110 transition-all"
            >
              <ArrowDownLeft size={16} />
              {copy.depositBtn}
            </button>
          </div>
        </section>

        {/* Card 2: Promo / Referral Code Section (Distinct Charcoal Card) */}
        <section className="lg:col-span-4 rounded-2xl bg-[#141c2c] border border-slate-700/60 p-5 flex flex-col justify-between shadow-[0_12px_32px_rgba(2,6,23,0.4)]">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#14b8a6] flex items-center gap-1.5">
                <TicketPercent size={15} />
                {copy.promoSectionTitle}
              </span>
              {referralCode && (
                <button
                  type="button"
                  onClick={handleCopyRefCode}
                  className="text-[11px] font-mono font-bold text-[#cbd5e1] bg-[#1e293b] border border-slate-600/60 px-2 py-1 rounded-lg flex items-center gap-1 hover:border-[#22d3ee]"
                >
                  {copiedCode ? <Check size={12} className="text-[#22d3ee]" /> : <Copy size={12} />}
                  {referralCode}
                </button>
              )}
            </div>

            <form onSubmit={handlePromoSubmit} className="mt-3 space-y-2.5">
              <input
                type="text"
                value={promoCodeInput}
                onChange={(e) => setPromoCodeInput(e.target.value)}
                disabled={Boolean(referredByCode)}
                placeholder={
                  referredByCode
                    ? lang === 'am'
                      ? `ተተግብሯል (${referredByCode})`
                      : `Applied (${referredByCode})`
                    : copy.promoPlaceholder
                }
                aria-label="Promo or referral code"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0b1220] border border-slate-600/60 text-xs font-mono font-bold text-white placeholder:text-slate-500 focus:outline-none focus:border-[#22d3ee] disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={promoBusy || Boolean(referredByCode)}
                className="w-full py-2.5 px-4 rounded-xl bg-[#1e293b] border border-[#14b8a6]/50 text-[#5eead4] text-xs font-extrabold flex items-center justify-center gap-1.5 hover:bg-[#14b8a6]/15 transition-colors disabled:opacity-50"
              >
                <Sparkles size={14} />
                {promoBusy ? '...' : copy.applyPromoBtn}
              </button>
            </form>
          </div>

          {promoFeedback && (
            <p
              className={`mt-2.5 text-[11px] font-bold ${
                promoFeedback.ok ? 'text-[#22d3ee]' : 'text-rose-400'
              }`}
            >
              {promoFeedback.text}
            </p>
          )}
        </section>

        {/* Card 3: Winnings Balance (Distinct Gold-Accented Dark Card) */}
        <section className="lg:col-span-4 rounded-2xl bg-gradient-to-br from-[#1b1912] via-[#171b28] to-[#0f172a] border border-[#facc15]/40 p-5 flex flex-col justify-between shadow-[0_12px_32px_rgba(2,6,23,0.45)]">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-[#fde047] block">
                {copy.winningsBalanceTitle}
              </span>
              <b
                data-testid="wallet-winnings-balance"
                className="font-['Outfit'] text-3xl sm:text-4xl font-extrabold text-[#facc15] tabular-nums block mt-2"
              >
                {winningsBalance.toFixed(2)}{' '}
                <span className="text-lg font-bold text-[#fde047]/80">ETB</span>
              </b>
            </div>
            <span className="w-11 h-11 rounded-2xl bg-[#facc15]/15 border border-[#facc15]/40 flex items-center justify-center text-[#facc15] shrink-0">
              <Trophy size={22} />
            </span>
          </div>

          <div className="pt-5">
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel((prev) => (prev === 'withdraw' ? 'none' : 'withdraw'));
                if (mode !== 'wallet') onNavigate('wallet');
              }}
              className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#facc15] to-[#f59e0b] text-[#1e1402] text-xs font-extrabold flex items-center justify-center gap-2 shadow-[0_6px_20px_rgba(245,158,11,0.28)] hover:brightness-105 transition-all"
            >
              <ArrowUpRight size={16} />
              {copy.withdrawBtn}
            </button>
          </div>
        </section>
      </div>

      {/* Collapsible Deposit or Withdrawal Action Drawer */}
      {showDepositForm && (
        <form
          onSubmit={handleDepositSubmit}
          className="rounded-2xl bg-[#0f1a2e] border border-[#22d3ee]/35 p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-extrabold uppercase text-[#22d3ee]">
                {lang === 'am' ? 'የሙከራ ተቀማጭ ጥያቄ' : 'DEMO DEPOSIT REQUEST'}
              </span>
              <h3 className="font-['Outfit'] text-lg font-extrabold text-white">
                {lang === 'am' ? 'የሙከራ ሂሳብ ማስገቢያ' : 'Submit Demo Deposit Request'}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="text-xs font-bold text-[#94a3b8] hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#cbd5e1] mb-1.5">
                {lang === 'am' ? 'የክፍያ ዘዴ (Demo)' : 'Sandbox Method'}
              </label>
              <select
                value={depositProvider}
                onChange={(e) => setDepositProvider(e.target.value)}
                aria-label="Sandbox Payment Method"
                className="w-full px-3 py-2.5 rounded-xl border border-[#253a5e] bg-[#08101f] text-xs font-bold text-white"
              >
                {DEMO_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#cbd5e1] mb-1.5">
                {lang === 'am' ? 'መጠን (ETB)' : 'Amount (ETB)'}
              </label>
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                aria-label="Demo deposit amount in ETB"
                className="w-full px-3 py-2.5 rounded-xl border border-[#253a5e] bg-[#08101f] text-sm font-bold text-white tabular-nums"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {[50, 100, 200, 500].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => setDepositAmount(String(amt))}
                className={`px-3 py-1.5 rounded-lg text-xs font-extrabold tabular-nums border ${
                  depositAmount === String(amt)
                    ? 'bg-[#22d3ee]/20 border-[#22d3ee] text-[#22d3ee]'
                    : 'bg-[#14223b] border-[#253a5e] text-[#cbd5e1]'
                }`}
              >
                +{amt} ETB
              </button>
            ))}
          </div>

          {depositError && <p className="text-xs font-bold text-rose-400">{depositError}</p>}

          <button
            type="submit"
            disabled={depositBusy}
            className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#22d3ee] to-[#06b6d4] text-[#041423] text-xs font-extrabold hover:brightness-110 disabled:opacity-60"
          >
            {depositBusy
              ? '...'
              : lang === 'am'
                ? `${depositAmount || 0} ETB የተቀማጭ ጥያቄ ላክ`
                : `Submit ${depositAmount || 0} ETB Deposit Request`}
          </button>
        </form>
      )}

      {showWithdrawForm && (
        <form
          onSubmit={handleWithdrawSubmit}
          className="rounded-2xl bg-[#0f1a2e] border border-[#facc15]/40 p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-extrabold uppercase text-[#facc15]">
                {lang === 'am' ? 'የሙከራ ወጪ ጥያቄ' : 'DEMO WITHDRAWAL REQUEST'}
              </span>
              <h3 className="font-['Outfit'] text-lg font-extrabold text-white">
                {lang === 'am' ? 'የሙከራ ገንዘብ ማውጫ' : 'Submit Demo Withdrawal Request'}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveActionPanel('none');
                onNavigate('wallet');
              }}
              className="text-xs font-bold text-[#94a3b8] hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#cbd5e1] mb-1.5">
                {lang === 'am' ? 'መቀበያ ዘዴ (Demo)' : 'Payout Method (Demo)'}
              </label>
              <select
                value={withdrawProvider}
                onChange={(e) => setWithdrawProvider(e.target.value)}
                aria-label="Destination Method"
                className="w-full px-3 py-2.5 rounded-xl border border-[#253a5e] bg-[#08101f] text-xs font-bold text-white"
              >
                {DEMO_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {lang === 'am' ? p.nameAm : p.nameEn}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#cbd5e1] mb-1.5">
                {lang === 'am' ? 'የወጪ መጠን (ቢያንስ 20 ETB)' : 'Withdrawal Amount (Min 20 ETB)'}
              </label>
              <input
                type="number"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                aria-label="Demo withdrawal amount in ETB"
                className="w-full px-3 py-2.5 rounded-xl border border-[#253a5e] bg-[#08101f] text-sm font-bold text-white tabular-nums"
              />
            </div>
          </div>

          {withdrawError && <p className="text-xs font-bold text-rose-400">{withdrawError}</p>}

          <button
            type="submit"
            disabled={withdrawBusy}
            className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#facc15] to-[#f59e0b] text-[#1e1402] text-xs font-extrabold hover:brightness-105 disabled:opacity-60"
          >
            {withdrawBusy
              ? '...'
              : lang === 'am'
                ? 'የሙከራ ወጪ ጥያቄ ላክ'
                : 'Submit Demo Withdrawal Request'}
          </button>
        </form>
      )}

      {/* Pending / Recent Deposit & Payout Requests */}
      {(depositRequests.length > 0 || payoutRequests.length > 0) && (
        <section className="rounded-2xl bg-[#0f1a2e] border border-slate-700/50 p-4 space-y-2.5">
          <h3 className="text-xs font-extrabold uppercase tracking-wider text-[#94a3b8]">
            {copy.recentRequestsTitle}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {depositRequests.slice(0, 3).map((d) => (
              <div
                key={d.depositId}
                className="flex items-center justify-between p-3 rounded-xl bg-[#091221] border border-[#1e3252] text-xs"
              >
                <div>
                  <b className="text-white block">
                    +{d.amountEtb.toFixed(2)} ETB · {d.provider}
                  </b>
                  <span className="font-mono text-[10px] text-[#94a3b8]">{d.referenceCode}</span>
                </div>
                <span className="px-2 py-0.5 rounded-md bg-[#22d3ee]/15 text-[#22d3ee] font-bold text-[10px]">
                  {d.status}
                </span>
              </div>
            ))}
            {payoutRequests.slice(0, 3).map((w) => (
              <div
                key={w.requestId}
                className="flex items-center justify-between p-3 rounded-xl bg-[#091221] border border-[#1e3252] text-xs"
              >
                <div>
                  <b className="text-[#facc15] block">
                    -{w.requestedAmountEtb.toFixed(2)} ETB · {w.paymentMethod}
                  </b>
                  <span className="font-mono text-[10px] text-[#94a3b8]">{w.requestId}</span>
                </div>
                <span className="px-2 py-0.5 rounded-md bg-[#facc15]/15 text-[#fde047] font-bold text-[10px]">
                  {w.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Transaction History with Empty State */}
      <section className="rounded-2xl bg-[#0f1a2e] border border-slate-700/50 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[10px] font-extrabold uppercase text-[#22d3ee] flex items-center gap-1.5">
              <Receipt size={13} />
              {lang === 'am' ? 'የግብይት መዝገብ' : 'TRANSACTION LEDGER'}
            </span>
            <h3 className="font-['Outfit'] text-xl font-extrabold text-white mt-0.5">
              {copy.recentTransactionsTitle}
            </h3>
          </div>

          <span className="text-xs font-bold text-[#94a3b8] tabular-nums">
            {transactions.length} {lang === 'am' ? 'መዝገቦች' : 'entries'}
          </span>
        </div>

        {transactions.length === 0 ? (
          <div
            data-testid="wallet-empty-transactions"
            className="py-10 px-4 text-center rounded-2xl bg-[#091221] border border-dashed border-[#1e3252]"
          >
            <Receipt size={28} className="mx-auto text-[#475569] mb-2" />
            <b className="block text-sm font-extrabold text-white">{copy.emptyTransactionsTitle}</b>
            <p className="text-xs text-[#94a3b8] mt-1 max-w-sm mx-auto">
              {copy.emptyTransactionsDesc}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#1e3252]">
            {transactions.map((tx) => {
              const isPositive = tx.amount >= 0;
              return (
                <div
                  key={tx.id}
                  className="py-3.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        tx.type === 'bingo_win'
                          ? 'bg-[#facc15]/15 text-[#facc15]'
                          : isPositive
                            ? 'bg-[#22d3ee]/15 text-[#22d3ee]'
                            : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {isPositive ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
                    </span>
                    <div className="min-w-0">
                      <b className="block text-xs font-extrabold text-white truncate">
                        {lang === 'am' ? tx.labelAm : tx.labelEn}
                      </b>
                      <div className="flex items-center gap-2 text-[11px] text-[#94a3b8] mt-0.5">
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
                          ? 'text-[#facc15]'
                          : isPositive
                            ? 'text-[#22d3ee]'
                            : 'text-slate-200'
                      }`}
                    >
                      {isPositive ? `+${tx.amount.toFixed(2)}` : tx.amount.toFixed(2)} ETB
                    </b>
                    <span className="inline-flex items-center gap-1 text-[10px] text-[#94a3b8]">
                      {tx.status === 'demo_completed' ? (
                        <CheckCircle2 size={11} className="text-[#22d3ee]" />
                      ) : (
                        <Clock size={11} className="text-[#facc15]" />
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
