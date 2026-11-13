import { useState } from 'react';
import {
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  ShieldAlert,
  CheckCircle2,
  Clock,
  Receipt,
} from 'lucide-react';
import { Language, ScreenId, WalletTransaction } from '../types/bingo';

interface WalletScreensProps {
  mode: 'wallet' | 'deposit' | 'withdraw';
  lang: Language;
  demoBalance: number;
  transactions: WalletTransaction[];
  onSimulateDeposit: (amount: number, provider: string) => void;
  onSimulateWithdraw: (amount: number, provider: string, accountPhone: string) => boolean;
  onNavigate: (screen: ScreenId) => void;
}

const DEMO_PROVIDERS = [
  { id: 'Telebirr (Demo Sandbox)', nameAm: 'ቴሌብር (የሙከራ ሳንድቦክስ)', nameEn: 'Telebirr (Demo Sandbox)' },
  { id: 'CBE Birr (Demo Sandbox)', nameAm: 'ሲቢኢ ብር (የሙከራ ሳንድቦክስ)', nameEn: 'CBE Birr (Demo Sandbox)' },
  { id: 'BOA Amole (Demo Sandbox)', nameAm: 'አቢሲኒያ ባንክ (የሙከራ ሳንድቦክስ)', nameEn: 'BOA (Demo Sandbox)' },
];

export function WalletScreens({
  mode,
  lang,
  demoBalance,
  transactions,
  onSimulateDeposit,
  onSimulateWithdraw,
  onNavigate,
}: WalletScreensProps) {
  const [depositAmount, setDepositAmount] = useState('100');
  const [depositProvider, setDepositProvider] = useState(DEMO_PROVIDERS[0].id);
  const [depositError, setDepositError] = useState('');

  const [withdrawAmount, setWithdrawAmount] = useState('50');
  const [withdrawProvider, setWithdrawProvider] = useState(DEMO_PROVIDERS[0].id);
  const [withdrawPhone, setWithdrawPhone] = useState('+251911000000');
  const [withdrawError, setWithdrawError] = useState('');

  const handleDepositSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Number(depositAmount);
    if (!Number.isFinite(parsed) || parsed < 10 || parsed > 5000) {
      setDepositError(
        lang === 'am'
          ? 'እባክዎ ከ 10 እስከ 5,000 ETB መካከል ያለ የሙከራ መጠን ያስገቡ።'
          : 'Please enter a valid demo amount between 10 and 5,000 ETB.'
      );
      return;
    }
    setDepositError('');
    onSimulateDeposit(parsed, depositProvider);
  };

  const handleWithdrawSubmit = (e: React.FormEvent) => {
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
          ? 'በቂ የሙከራ ቀሪ ሂሳብ የለዎትም።'
          : 'Insufficient demo balance for this withdrawal.'
      );
      return;
    }
    if (withdrawPhone.trim().length < 9) {
      setWithdrawError(
        lang === 'am'
          ? 'እባክዎ ትክክለኛ የሙከራ ስልክ ቁጥር ያስገቡ።'
          : 'Please enter a valid phone/account number.'
      );
      return;
    }
    setWithdrawError('');
    onSimulateWithdraw(parsed, withdrawProvider, withdrawPhone.trim());
  };

  return (
    <div className="space-y-5">
      {/* Legal & Compliance Sandbox Notice */}
      <div className="bg-[#fef8e6] border border-[#f3d683] rounded-2xl p-4 flex items-start gap-3 text-[#65490b]">
        <ShieldAlert size={20} className="shrink-0 mt-0.5 text-[#c78d12]" />
        <div className="text-xs leading-relaxed">
          <b className="block font-extrabold text-sm text-[#4e3706]">
            {lang === 'am'
              ? 'የሙከራ ቦርሳ ብቻ (Demo Sandbox Mode — እውነተኛ ገንዘብ አይቀበልም)'
              : 'Demo Sandbox Only — Real-Money Transactions Disabled'}
          </b>
          <span>
            {lang === 'am'
              ? 'የህግ፣ የፈቃድ እና የክፍያ ተቋማት ማረጋገጫ እስኪጠናቀቅ ድረስ ሁሉም ሂሳቦች፣ ተቀማጭ እና ወጪዎች ለሙከራ (Demo) ብቻ የሚያገለግሉ ናቸው።'
              : 'All balances, deposits, and withdrawals in this milestone are virtual demo credits for UX testing. Real-money payments remain disabled pending regulatory licensing and payment-provider verification.'}
          </span>
        </div>
      </div>

      {/* Sub-navigation Tabs: Wallet Overview / Deposit / Withdraw */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-[#e3ede6] rounded-2xl p-3">
        <div className="flex items-center gap-1.5 bg-[#eef7f1] p-1 rounded-xl">
          <button
            type="button"
            onClick={() => onNavigate('wallet')}
            className={`px-3.5 py-2 rounded-lg text-xs font-extrabold transition-colors ${
              mode === 'wallet'
                ? 'bg-[#087e50] text-white'
                : 'text-[#3d5f4c] hover:text-[#087e50]'
            }`}
          >
            {lang === 'am' ? 'የቦርሳ ማጠቃለያ' : 'Wallet Overview'}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('deposit')}
            className={`px-3.5 py-2 rounded-lg text-xs font-extrabold transition-colors ${
              mode === 'deposit'
                ? 'bg-[#087e50] text-white'
                : 'text-[#3d5f4c] hover:text-[#087e50]'
            }`}
          >
            {lang === 'am' ? '＋ የሙከራ ተቀማጭ (Deposit)' : '＋ Demo Deposit'}
          </button>
          <button
            type="button"
            onClick={() => onNavigate('withdraw')}
            className={`px-3.5 py-2 rounded-lg text-xs font-extrabold transition-colors ${
              mode === 'withdraw'
                ? 'bg-[#087e50] text-white'
                : 'text-[#3d5f4c] hover:text-[#087e50]'
            }`}
          >
            {lang === 'am' ? '↗ የሙከራ ወጪ (Withdraw)' : '↗ Demo Withdraw'}
          </button>
        </div>

        <div className="text-right">
          <small className="text-[10px] font-extrabold uppercase text-[#6e8577] block">
            {lang === 'am' ? 'የሙከራ ቀሪ ሂሳብ' : 'AVAILABLE DEMO BALANCE'}
          </small>
          <b
            data-testid="wallet-demo-balance"
            className="font-['Outfit'] text-xl font-extrabold text-[#087e50] tabular-nums"
          >
            {demoBalance.toFixed(2)} ETB
          </b>
        </div>
      </div>

      {/* Mode Content */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left 5 Columns: Balance Card + Active Deposit or Withdraw Form */}
        <section className="lg:col-span-5 space-y-4">
          <div className="bg-gradient-to-br from-[#075d3c] via-[#087e50] to-[#14a366] text-white rounded-3xl p-6 shadow-md space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold tracking-wider uppercase text-[#c8f6d9]">
                ADEYBINGO · DEMO WALLET
              </span>
              <Wallet size={22} className="text-[#fde047]" />
            </div>

            <div>
              <small className="text-xs text-[#d3f6e1] block">
                {lang === 'am' ? 'ጠቅላላ የሙከራ ሂሳብ' : 'Total Demo Credits'}
              </small>
              <h2 className="font-['Outfit'] text-4xl font-extrabold tabular-nums mt-1">
                {demoBalance.toFixed(2)} <span className="text-xl text-[#fde047]">ETB</span>
              </h2>
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => onNavigate('deposit')}
                className="py-2.5 px-3 rounded-xl bg-white text-[#087e50] text-xs font-extrabold flex items-center justify-center gap-1.5 shadow-2xs"
              >
                <ArrowDownLeft size={15} />
                {lang === 'am' ? 'ሂሳብ ሙላ (Demo)' : 'Deposit (Demo)'}
              </button>
              <button
                type="button"
                onClick={() => onNavigate('withdraw')}
                className="py-2.5 px-3 rounded-xl bg-white/15 border border-white/30 text-white text-xs font-extrabold flex items-center justify-center gap-1.5 hover:bg-white/25"
              >
                <ArrowUpRight size={15} />
                {lang === 'am' ? 'ወጪ አድርግ (Demo)' : 'Withdraw (Demo)'}
              </button>
            </div>
          </div>

          {/* Deposit Form (shown on 'deposit' or 'wallet') */}
          {(mode === 'deposit' || mode === 'wallet') && (
            <form
              onSubmit={handleDepositSubmit}
              className="bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4"
            >
              <div>
                <span className="text-[10px] font-extrabold uppercase text-[#12a566]">
                  {lang === 'am' ? 'የሙከራ ሂሳብ መሙያ' : 'SANDBOX DEPOSIT'}
                </span>
                <h3 className="font-['Outfit'] text-lg font-extrabold text-[#193b2b]">
                  {lang === 'am'
                    ? 'የሙከራ ክሬዲት ወደ ቦርሳዎ ይጨምሩ'
                    : 'Add Demo Credits to Your Wallet'}
                </h3>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1.5">
                  {lang === 'am' ? 'የሙከራ ክፍያ አማራጭ' : 'Sandbox Payment Method'}
                </label>
                <select
                  value={depositProvider}
                  onChange={(e) => setDepositProvider(e.target.value)}
                  aria-label="Sandbox Payment Method"
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-[#f9fcfa] text-xs font-bold text-[#193b2b]"
                >
                  {DEMO_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {lang === 'am' ? p.nameAm : p.nameEn}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1.5">
                  {lang === 'am' ? 'መጠን (ETB — የሙከራ)' : 'Amount (ETB — Demo)'}
                </label>
                <div className="grid grid-cols-4 gap-1.5 mb-2">
                  {[50, 100, 200, 500].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setDepositAmount(String(amt))}
                      className={`py-1.5 rounded-lg text-xs font-extrabold tabular-nums border ${
                        depositAmount === String(amt)
                          ? 'bg-[#e9f8ef] border-[#087e50] text-[#087e50]'
                          : 'bg-[#f6faf7] border-[#e2ece5] text-[#4b6757]'
                      }`}
                    >
                      +{amt}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  aria-label="Demo deposit amount in ETB"
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-white text-sm font-bold text-[#193b2b] tabular-nums"
                />
              </div>

              {depositError && (
                <p className="text-xs font-bold text-red-600">{depositError}</p>
              )}

              <button
                type="submit"
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#12ad68] to-[#087e50] text-white text-xs font-extrabold shadow-xs hover:brightness-105"
              >
                {lang === 'am'
                  ? `＋ ${depositAmount || 0} ETB የሙከራ ሂሳብ ጨምር`
                  : `＋ Credit ${depositAmount || 0} ETB Demo Balance`}
              </button>
            </form>
          )}

          {/* Withdraw Form (shown on 'withdraw') */}
          {mode === 'withdraw' && (
            <form
              onSubmit={handleWithdrawSubmit}
              className="bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4"
            >
              <div>
                <span className="text-[10px] font-extrabold uppercase text-[#d49a19]">
                  {lang === 'am' ? 'የሙከራ ወጪ መጠየቂያ' : 'SANDBOX WITHDRAWAL'}
                </span>
                <h3 className="font-['Outfit'] text-lg font-extrabold text-[#193b2b]">
                  {lang === 'am'
                    ? 'የሙከራ ወጪ ሂደትን ይፈትሹ'
                    : 'Simulate a Withdrawal Request'}
                </h3>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1.5">
                  {lang === 'am' ? 'መቀበያ ዘዴ (Demo)' : 'Destination Method (Demo)'}
                </label>
                <select
                  value={withdrawProvider}
                  onChange={(e) => setWithdrawProvider(e.target.value)}
                  aria-label="Destination Method"
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-[#f9fcfa] text-xs font-bold text-[#193b2b]"
                >
                  {DEMO_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {lang === 'am' ? p.nameAm : p.nameEn}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1.5">
                  {lang === 'am' ? 'የስልክ ወይም የሂሳብ ቁጥር' : 'Account / Phone Number'}
                </label>
                <input
                  type="text"
                  value={withdrawPhone}
                  onChange={(e) => setWithdrawPhone(e.target.value)}
                  aria-label="Account or Phone Number"
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-white text-xs font-bold text-[#193b2b] font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-[#355644] mb-1.5">
                  {lang === 'am' ? 'የወጪ መጠን (ETB — የሙከራ)' : 'Withdrawal Amount (ETB — Demo)'}
                </label>
                <input
                  type="number"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  aria-label="Demo withdrawal amount in ETB"
                  className="w-full px-3 py-2.5 rounded-xl border border-[#d7e6dc] bg-white text-sm font-bold text-[#193b2b] tabular-nums"
                />
              </div>

              {withdrawError && (
                <p className="text-xs font-bold text-red-600">{withdrawError}</p>
              )}

              <button
                type="submit"
                className="w-full py-3 px-4 rounded-xl bg-[#193b2b] text-white text-xs font-extrabold shadow-xs hover:bg-[#087e50] transition-colors"
              >
                {lang === 'am'
                  ? 'የሙከራ ወጪ ጥያቄ ላክ'
                  : 'Submit Demo Withdrawal Request'}
              </button>
            </form>
          )}
        </section>

        {/* Right 7 Columns: Demo Ledger Transaction History */}
        <section className="lg:col-span-7 bg-white border border-[#e3ede6] rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-extrabold uppercase text-[#12a566] flex items-center gap-1">
                <Receipt size={13} />
                {lang === 'am' ? 'የሙከራ እንቅስቃሴ መዝገብ' : 'DEMO TRANSACTION LEDGER'}
              </span>
              <h3 className="font-['Outfit'] text-xl font-extrabold text-[#193b2b]">
                {lang === 'am' ? 'የቅርብ ጊዜ የቦርሳ እንቅስቃሴዎች' : 'Recent Ledger Activity'}
              </h3>
            </div>

            <span className="text-xs font-bold text-[#627a6c] tabular-nums">
              {transactions.length} {lang === 'am' ? 'መዝገቦች' : 'entries'}
            </span>
          </div>

          <div className="divide-y divide-[#edf4ef]">
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
                        isPositive
                          ? 'bg-[#e7f8ed] text-[#087e50]'
                          : 'bg-[#fef3c7] text-[#b45309]'
                      }`}
                    >
                      {isPositive ? (
                        <ArrowDownLeft size={17} />
                      ) : (
                        <ArrowUpRight size={17} />
                      )}
                    </span>
                    <div className="min-w-0">
                      <b className="block text-xs font-extrabold text-[#193b2b] truncate">
                        {lang === 'am' ? tx.labelAm : tx.labelEn}
                      </b>
                      <div className="flex items-center gap-2 text-[11px] text-[#788e80] mt-0.5">
                        <span>{tx.timestamp}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{tx.reference}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <b
                      className={`font-['Outfit'] text-sm font-extrabold tabular-nums block ${
                        isPositive ? 'text-[#087e50]' : 'text-[#193b2b]'
                      }`}
                    >
                      {isPositive ? `+${tx.amount.toFixed(2)}` : tx.amount.toFixed(2)} ETB
                    </b>
                    <span className="inline-flex items-center gap-1 text-[10px] text-[#688071]">
                      {tx.status === 'demo_completed' ? (
                        <CheckCircle2 size={11} className="text-[#087e50]" />
                      ) : (
                        <Clock size={11} className="text-[#d49a19]" />
                      )}
                      {lang === 'am' ? 'የሙከራ መዝገብ' : 'Demo Sandbox'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
