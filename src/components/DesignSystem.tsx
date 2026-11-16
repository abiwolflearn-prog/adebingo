import React from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Clock,
  Coins,
  Gift,
  Globe,
  Home,
  Loader2,
  ShieldCheck,
  Sparkles,
  Trophy,
  User,
  Volume2,
  VolumeX,
  Wallet,
} from 'lucide-react';
import { ScreenId, Language } from '../types/bingo';
import { BingoBall3D, BingoBall3DProps } from './BingoBall3D';

/**
 * Centralized ADEYBINGO Design Tokens
 * Ensures every screen, account, and referral session uses the exact same theme.
 */
export const ADEY_THEME = {
  primaryEmerald: '#159447',
  darkEmerald: '#08743A',
  lightEmerald: '#E6F6EB',
  gold: '#F5BD42',
  darkGold: '#D99B20',
  warmBg: '#FFF9ED',
  cardBg: '#FFFFFF',
  textPrimary: '#183326',
  textSecondary: '#68776D',
  success: '#168A49',
  danger: '#D94B4B',
  border: '#E7EDE8',
} as const;

/* ============================================================================
 * 1. AppHeader
 * ========================================================================== */
export interface AppHeaderProps {
  lang: Language;
  countdownLabel: string;
  isLive?: boolean;
  isUrgent?: boolean;
  demoBalance: number;
  sound?: boolean;
  onToggleSound?: () => void;
  showBackButton?: boolean;
  onBack?: () => void;
  onBrandClick: () => void;
  onTimerClick?: () => void;
  onWalletClick: () => void;
  onToggleLanguage: () => void;
  showAdminButton?: boolean;
  isAdminActive?: boolean;
  onAdminClick?: () => void;
}

export function AppHeader({
  lang,
  countdownLabel,
  isLive = false,
  isUrgent = false,
  demoBalance,
  sound = true,
  onToggleSound,
  showBackButton = false,
  onBack,
  onBrandClick,
  onTimerClick,
  onWalletClick,
  onToggleLanguage,
  showAdminButton = false,
  isAdminActive = false,
  onAdminClick,
}: AppHeaderProps) {
  return (
    <header className="adey-header">
      <div className="flex items-center gap-1.5 shrink-0">
        {showBackButton && onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={lang === 'am' ? 'ተመለስ' : 'Back'}
            className="w-9 h-9 rounded-xl bg-white border border-[#E7EDE8] text-[#183326] hover:bg-[#E6F6EB] hover:border-[#159447]/40 flex items-center justify-center transition-colors shadow-2xs shrink-0"
          >
            <ArrowLeft className="w-4 h-4 text-[#159447]" />
          </button>
        )}
        <button
          type="button"
          className="brand text-left bg-transparent border-0 p-0 min-h-[42px] cursor-pointer select-none"
          onClick={onBrandClick}
        >
          <b className="logo">A</b>
          <div className="flex flex-col leading-none">
            <strong>
              ADEY<span>BINGO</span>
            </strong>
            <span className="text-[10px] font-bold text-[#68776D] hidden sm:inline mt-0.5">
              {lang === 'am' ? 'የቴሌግራም ቢንጎ ጨዋታ' : 'Telegram Bingo Club'}
            </span>
          </div>
        </button>
      </div>

      <div className="actions">
        <button
          type="button"
          data-testid="header-timer"
          onClick={onTimerClick || onBrandClick}
          aria-label={lang === 'am' ? 'የዙር ሰዓት ቆጣሪ' : 'Round timer'}
          className={
            isLive
              ? '!bg-[#159447] !border-[#08743A] !text-white'
              : isUrgent
                ? '!bg-[#FEF5DC] !border-[#F5BD42] !text-[#9A6B0B]'
                : '!bg-[#E6F6EB] !border-[#159447]/30 !text-[#08743A]'
          }
        >
          <Clock
            className={`w-3.5 h-3.5 shrink-0 ${
              isLive ? 'text-[#F5BD42]' : isUrgent ? 'text-[#D99B20] animate-pulse' : 'text-[#159447]'
            }`}
          />
          <span className="font-mono tabular-nums font-extrabold">{countdownLabel}</span>
        </button>

        <button
          type="button"
          onClick={onWalletClick}
          aria-label={lang === 'am' ? 'የሙከራ ቦርሳ' : 'Demo Wallet'}
          className="!bg-[#FEF5DC] !border-[#F5BD42]/70 !text-[#183326]"
        >
          <Coins className="w-3.5 h-3.5 text-[#D99B20] shrink-0" />
          <span data-testid="home-demo-balance" className="tabular-nums font-extrabold text-[#183326]">
            {demoBalance.toFixed(2)} ETB
          </span>
        </button>

        <button
          type="button"
          data-testid="lang-toggle"
          onClick={onToggleLanguage}
          aria-label="Switch language between Amharic and English"
        >
          <Globe className="w-3.5 h-3.5 text-[#159447] shrink-0" />
          <span>{lang === 'am' ? 'አማ' : 'EN'}</span>
        </button>

        {onToggleSound && (
          <button
            type="button"
            onClick={onToggleSound}
            aria-label={sound ? 'Mute sound' : 'Unmute sound'}
          >
            {sound ? (
              <Volume2 className="w-3.5 h-3.5 text-[#159447] shrink-0" />
            ) : (
              <VolumeX className="w-3.5 h-3.5 text-[#68776D] shrink-0" />
            )}
          </button>
        )}

        {showAdminButton && onAdminClick && (
          <button
            type="button"
            data-testid="owner-admin-btn"
            onClick={onAdminClick}
            aria-label="Owner Admin Panel"
            className={
              isAdminActive
                ? '!bg-[#159447] !text-white !border-[#08743A]'
                : '!bg-[#FEF5DC] !text-[#9A6B0B] !border-[#F5BD42]'
            }
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[#D99B20] shrink-0" />
            <span>{lang === 'am' ? 'አስተዳዳሪ' : 'Admin'}</span>
          </button>
        )}
      </div>
    </header>
  );
}

/* ============================================================================
 * 2. BalanceCard
 * ========================================================================== */
export interface BalanceCardProps {
  label: string;
  amount: string | number;
  unit?: string;
  subtitle?: string;
  variant?: 'emerald' | 'gold' | 'white';
  badgeText?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
  className?: string;
}

export function BalanceCard({
  label,
  amount,
  unit = 'Pts',
  subtitle,
  variant = 'white',
  badgeText,
  icon,
  action,
  testId,
  className = '',
}: BalanceCardProps) {
  const styles = {
    emerald:
      'bg-gradient-to-br from-[#159447] to-[#08743A] text-white border-[#08743A] shadow-[0_12px_28px_rgba(21,148,71,0.22)]',
    gold: 'bg-gradient-to-br from-[#FEF5DC] via-[#FFF9ED] to-white text-[#183326] border-[#F5BD42]/60 shadow-[0_8px_22px_rgba(217,155,32,0.14)]',
    white:
      'bg-white text-[#183326] border-[#E7EDE8] shadow-[0_6px_20px_rgba(24,51,38,0.06)]',
  }[variant];

  const labelColor =
    variant === 'emerald'
      ? 'text-[#E6F6EB]'
      : variant === 'gold'
      ? 'text-[#9A6B0B]'
      : 'text-[#68776D]';

  const amountColor =
    variant === 'emerald'
      ? 'text-white'
      : variant === 'gold'
      ? 'text-[#183326]'
      : 'text-[#159447]';

  return (
    <div
      data-testid={testId}
      className={`rounded-2xl border p-4 transition-all ${styles} ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${labelColor}`}>
            {icon}
            <span>{label}</span>
          </div>
          <div className={`mt-1.5 text-2xl sm:text-3xl font-['Outfit'] font-extrabold tabular-nums ${amountColor}`}>
            {typeof amount === 'number' ? amount.toLocaleString() : amount}{' '}
            {unit && (
              <span
                className={`text-xs sm:text-sm font-bold ${
                  variant === 'emerald' ? 'text-[#F5BD42]' : 'text-[#68776D]'
                }`}
              >
                {unit}
              </span>
            )}
          </div>
        </div>
        {badgeText && (
          <span
            className={`text-[10px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg shrink-0 ${
              variant === 'emerald'
                ? 'bg-[#F5BD42] text-[#183326]'
                : 'bg-[#E6F6EB] text-[#08743A] border border-[#159447]/20'
            }`}
          >
            {badgeText}
          </span>
        )}
      </div>
      {(subtitle || action) && (
        <div className="mt-3 pt-2.5 border-t border-current/10 flex items-center justify-between gap-2">
          {subtitle && (
            <p className={`text-xs font-medium ${variant === 'emerald' ? 'text-[#E6F6EB]/90' : 'text-[#68776D]'}`}>
              {subtitle}
            </p>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 3. RewardCard
 * ========================================================================== */
export interface RewardCardProps {
  title: string;
  description: string;
  rewardHighlight?: string;
  badge?: string;
  onAction?: () => void;
  actionLabel?: string;
  secondaryAction?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function RewardCard({
  title,
  description,
  rewardHighlight,
  badge,
  onAction,
  actionLabel,
  secondaryAction,
  children,
  className = '',
}: RewardCardProps) {
  return (
    <div
      className={`rounded-2xl bg-gradient-to-br from-[#FFF9ED] via-white to-[#E6F6EB]/55 border-2 border-[#F5BD42]/60 p-4 sm:p-5 shadow-[0_8px_24px_rgba(217,155,32,0.12)] ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326] flex items-center justify-center shrink-0 shadow-[0_4px_12px_rgba(245,189,66,0.35)]">
            <Gift className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base sm:text-lg font-['Outfit'] font-extrabold text-[#183326]">
                {title}
              </h3>
              {badge && (
                <span className="text-[11px] font-extrabold bg-[#F5BD42]/30 text-[#9A6B0B] border border-[#F5BD42] px-2 py-0.5 rounded-lg">
                  {badge}
                </span>
              )}
            </div>
            <p className="text-xs sm:text-sm text-[#68776D] mt-0.5 leading-relaxed">
              {description}
            </p>
          </div>
        </div>

        {rewardHighlight && (
          <div className="bg-[#E6F6EB] border border-[#159447]/30 rounded-xl px-3 py-1.5 text-right shrink-0">
            <span className="text-xs sm:text-sm font-['Outfit'] font-extrabold text-[#08743A] flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-[#D99B20]" />
              {rewardHighlight}
            </span>
          </div>
        )}
      </div>

      {children && <div className="mt-3.5">{children}</div>}

      {(onAction || secondaryAction) && (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {onAction && actionLabel && (
            <PrimaryButton onClick={onAction} size="sm">
              {actionLabel}
            </PrimaryButton>
          )}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 4. BingoBall
 * ========================================================================== */
export function BingoBall(props: BingoBall3DProps) {
  return <BingoBall3D {...props} />;
}

/* ============================================================================
 * 5. BingoNumberTile (1-600 Card Selection Tile)
 * ========================================================================== */
export interface BingoNumberTileProps {
  cardNumber: number;
  isSelected: boolean;
  isTakenByOther?: boolean;
  isSpecialGold?: boolean;
  takenLabel?: string;
  selectedLabel?: string;
  onSelect: (cardNumber: number) => void;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function BingoNumberTile({
  cardNumber,
  isSelected,
  isTakenByOther = false,
  isSpecialGold = false,
  takenLabel,
  selectedLabel,
  onSelect,
  disabled = false,
  size = 'md',
}: BingoNumberTileProps) {
  const sizeClasses = {
    sm: 'min-h-[42px] text-xs rounded-xl',
    md: 'min-h-[48px] text-sm sm:text-base rounded-xl',
    lg: 'min-h-[54px] text-base sm:text-lg rounded-2xl',
  }[size];

  let stateClasses =
    'bg-white text-[#183326] border border-[#E7EDE8] hover:border-[#159447] hover:bg-[#E6F6EB]/55 shadow-[0_2px_5px_rgba(24,51,38,0.04)]';

  if (isSelected) {
    stateClasses = isSpecialGold
      ? 'bg-gradient-to-br from-[#159447] to-[#08743A] text-white border-2 border-[#F5BD42] ring-2 ring-[#F5BD42]/45 shadow-[0_6px_14px_rgba(21,148,71,0.28)] scale-[1.02]'
      : 'bg-gradient-to-br from-[#159447] to-[#08743A] text-white border-2 border-[#08743A] shadow-[0_5px_12px_rgba(21,148,71,0.26)] scale-[1.02]';
  } else if (isTakenByOther) {
    stateClasses =
      'bg-[#FFF4F4] text-[#D94B4B]/65 border border-[#D94B4B]/25 cursor-not-allowed opacity-75';
  } else if (isSpecialGold) {
    stateClasses =
      'bg-[#FEF5DC]/75 text-[#183326] border border-[#F5BD42] hover:bg-[#FEF5DC] shadow-[0_2px_6px_rgba(245,189,66,0.16)]';
  }

  return (
    <button
      type="button"
      disabled={disabled || isTakenByOther}
      onClick={() => onSelect(cardNumber)}
      aria-pressed={isSelected}
      aria-label={`Bingo card ${cardNumber}${isSelected ? ' selected' : ''}${
        isTakenByOther ? ' reserved' : ''
      }`}
      className={`relative font-['Outfit'] font-extrabold tabular-nums flex flex-col items-center justify-center transition-all select-none active:scale-95 ${sizeClasses} ${stateClasses}`}
    >
      <span className="leading-none">{cardNumber}</span>
      {isSelected && selectedLabel && (
        <span className="text-[9px] font-bold uppercase tracking-tight text-[#F5BD42] mt-0.5 leading-none">
          {selectedLabel}
        </span>
      )}
      {!isSelected && isTakenByOther && takenLabel && (
        <span className="text-[8px] font-bold uppercase tracking-tight text-[#D94B4B] mt-0.5 leading-none">
          {takenLabel}
        </span>
      )}
      {isSelected && (
        <span
          aria-hidden="true"
          className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[#F5BD42]"
        />
      )}
    </button>
  );
}

/* ============================================================================
 * 6. PrimaryButton & 7. SecondaryButton
 * ========================================================================== */
export interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'emerald' | 'gold' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  icon?: React.ReactNode;
}

export function PrimaryButton({
  children,
  variant = 'emerald',
  size = 'md',
  fullWidth = false,
  icon,
  className = '',
  disabled,
  ...rest
}: ActionButtonProps) {
  const variantClasses = {
    emerald:
      'bg-gradient-to-r from-[#159447] to-[#08743A] hover:from-[#16a04d] hover:to-[#098240] text-white border border-[#08743A] shadow-[0_6px_18px_rgba(21,148,71,0.28)]',
    gold: 'bg-gradient-to-r from-[#F5BD42] to-[#D99B20] hover:from-[#f7c555] hover:to-[#e0a326] text-[#183326] border border-[#D99B20] shadow-[0_6px_18px_rgba(245,189,66,0.32)]',
    danger:
      'bg-[#D94B4B] hover:bg-[#c53d3d] text-white border border-[#b83232] shadow-[0_6px_16px_rgba(217,75,75,0.25)]',
  }[variant];

  const sizeClasses = {
    sm: 'min-h-[40px] px-3.5 py-2 text-xs rounded-xl',
    md: 'min-h-[46px] px-4 py-2.5 text-sm rounded-xl',
    lg: 'min-h-[52px] px-5 py-3.5 text-base rounded-2xl',
  }[size];

  return (
    <button
      type="button"
      disabled={disabled}
      className={`font-['Outfit'] font-extrabold inline-flex items-center justify-center gap-2 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed ${variantClasses} ${sizeClasses} ${
        fullWidth ? 'w-full' : ''
      } ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  size = 'md',
  fullWidth = false,
  icon,
  className = '',
  disabled,
  ...rest
}: Omit<ActionButtonProps, 'variant'>) {
  const sizeClasses = {
    sm: 'min-h-[40px] px-3.5 py-2 text-xs rounded-xl',
    md: 'min-h-[46px] px-4 py-2.5 text-sm rounded-xl',
    lg: 'min-h-[52px] px-5 py-3.5 text-base rounded-2xl',
  }[size];

  return (
    <button
      type="button"
      disabled={disabled}
      className={`font-['Outfit'] font-bold bg-white hover:bg-[#E6F6EB] text-[#183326] hover:text-[#08743A] border border-[#E7EDE8] hover:border-[#159447]/40 shadow-[0_2px_8px_rgba(24,51,38,0.04)] inline-flex items-center justify-center gap-2 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed ${sizeClasses} ${
        fullWidth ? 'w-full' : ''
      } ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/* ============================================================================
 * 8. GameStatusBadge
 * ========================================================================== */
export interface GameStatusBadgeProps {
  status: 'open' | 'live' | 'completed' | 'bonus' | 'demo';
  label: string;
  pulse?: boolean;
}

export function GameStatusBadge({ status, label, pulse = false }: GameStatusBadgeProps) {
  const styles = {
    open: 'bg-[#E6F6EB] text-[#08743A] border-[#159447]/30',
    live: 'bg-[#159447] text-white border-[#08743A]',
    completed: 'bg-[#FFF9ED] text-[#68776D] border-[#E7EDE8]',
    bonus: 'bg-[#FEF5DC] text-[#9A6B0B] border-[#F5BD42]',
    demo: 'bg-[#E6F6EB] text-[#08743A] border-[#159447]/25',
  }[status];

  const dotColor = {
    open: 'bg-[#159447]',
    live: 'bg-[#F5BD42]',
    completed: 'bg-[#68776D]',
    bonus: 'bg-[#D99B20]',
    demo: 'bg-[#159447]',
  }[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-extrabold px-2.5 py-1 rounded-full border ${styles}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${dotColor} ${pulse ? 'animate-pulse' : ''}`}
      />
      <span>{label}</span>
    </span>
  );
}

/* ============================================================================
 * 9. BottomNavigation
 * ========================================================================== */
export interface BottomNavigationProps {
  screen: ScreenId;
  lang: Language;
  onNavigate: (target: ScreenId) => void;
}

export function BottomNavigation({ screen, lang, onNavigate }: BottomNavigationProps) {
  const isHomeActive =
    screen === 'home' || screen === 'lobby' || screen === 'cards' || screen === 'game';
  const isWalletActive = screen === 'wallet' || screen === 'deposit' || screen === 'withdraw';
  const isRankActive = screen === 'leaderboard';
  const isProfileActive =
    screen === 'profile' ||
    screen === 'referral' ||
    screen === 'support' ||
    screen === 'terms';

  return (
    <nav className="bottom-nav" aria-label="Primary Bottom Navigation">
      <button
        type="button"
        data-testid="nav-home"
        className={isHomeActive ? 'selected' : ''}
        onClick={() => onNavigate('home')}
      >
        <Home className="w-4 h-4" />
        <span>{lang === 'am' ? 'መነሻ' : 'Home'}</span>
      </button>
      <button
        type="button"
        data-testid="nav-leaderboard"
        className={isRankActive ? 'selected' : ''}
        onClick={() => onNavigate('leaderboard')}
      >
        <Trophy className="w-4 h-4" />
        <span>{lang === 'am' ? 'ደረጃ' : 'Ranks'}</span>
      </button>
      <button
        type="button"
        data-testid="nav-profile"
        className={isProfileActive ? 'selected' : ''}
        onClick={() => onNavigate('profile')}
      >
        <User className="w-4 h-4" />
        <span>{lang === 'am' ? 'መገለጫ' : 'Profile'}</span>
      </button>
      <button
        type="button"
        data-testid="nav-wallet"
        className={isWalletActive ? 'selected' : ''}
        onClick={() => onNavigate('wallet')}
      >
        <Wallet className="w-4 h-4" />
        <span>{lang === 'am' ? 'ቦርሳ' : 'Wallet'}</span>
      </button>
    </nav>
  );
}

/* ============================================================================
 * 10. EmptyState, 11. LoadingState, 12. ErrorState
 * ========================================================================== */
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  testId?: string;
}

export function EmptyState({ icon, title, description, action, testId }: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className="rounded-2xl bg-[#FFF9ED] border border-dashed border-[#159447]/30 p-6 text-center flex flex-col items-center justify-center"
    >
      {icon && (
        <div className="w-12 h-12 rounded-2xl bg-[#E6F6EB] text-[#159447] flex items-center justify-center mb-3 shadow-2xs">
          {icon}
        </div>
      )}
      <h4 className="font-['Outfit'] font-extrabold text-base text-[#183326]">{title}</h4>
      {description && (
        <p className="text-xs sm:text-sm text-[#68776D] mt-1 max-w-md">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading ADEYBINGO...' }: { label?: string }) {
  return (
    <div className="rounded-2xl bg-white border border-[#E7EDE8] p-8 text-center flex flex-col items-center justify-center shadow-xs">
      <Loader2 className="w-8 h-8 text-[#159447] animate-spin mb-2.5" />
      <p className="text-sm font-bold text-[#183326]">{label}</p>
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = 'Try Again',
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="rounded-2xl bg-[#FFF5F5] border border-[#D94B4B]/40 p-5 text-center flex flex-col items-center justify-center">
      <div className="w-11 h-11 rounded-2xl bg-[#D94B4B]/15 text-[#D94B4B] flex items-center justify-center mb-2.5">
        <AlertCircle className="w-6 h-6" />
      </div>
      <h4 className="font-['Outfit'] font-extrabold text-base text-[#183326]">{title}</h4>
      <p className="text-xs sm:text-sm text-[#68776D] mt-1 max-w-md">{message}</p>
      {onRetry && (
        <div className="mt-3.5">
          <PrimaryButton variant="danger" size="sm" onClick={onRetry}>
            {retryLabel}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}
