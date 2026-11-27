import React from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CircleHelp,
  Clock,
  Coins,
  Gamepad2,
  Gift,
  Globe,
  Home,
  Loader2,
  ShieldCheck,
  Sparkles,
  User,
  Volume2,
  VolumeX,
  Wallet,
} from 'lucide-react';
import { ScreenId, Language } from '../types/bingo';
import { BingoBall3D, BingoBall3DProps } from './BingoBall3D';

/**
 * Centralized ADEYBINGO Design Tokens (Text-Light, Icon-First Edition)
 * Ensures every screen, account, and referral session uses the exact same theme and compact geometry.
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

export const COMPACT_TOKENS = {
  cardPaddingSm: 'p-1.5 sm:p-2',
  cardPaddingMd: 'p-2 sm:p-2.5',
  sectionGap: 'space-y-1.5',
  elementGap: 'gap-1',
  headerHeight: '44px',
  buttonHeightSm: 'min-h-[32px]',
  buttonHeightMd: 'min-h-[36px]',
  buttonHeightLg: 'min-h-[40px]',
  tileSizeSm: 'min-h-[30px]',
  tileSizeMd: 'min-h-[34px]',
  tileSizeLg: 'min-h-[38px]',
} as const;

/* ============================================================================
 * 1. AppHeader (Ultra-Compact 44-48px Icon-First Sticky Header)
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
      <div className="flex items-center gap-1 shrink-0">
        {showBackButton && onBack && (
          <button
            type="button"
            onClick={onBack}
            title={lang === 'am' ? 'ተመለስ' : 'Back'}
            aria-label={lang === 'am' ? 'ተመለስ' : 'Back'}
            className="w-7 h-7 rounded-lg bg-white border border-[#E7EDE8] text-[#183326] hover:bg-[#E6F6EB] hover:border-[#159447]/40 flex items-center justify-center transition-colors shadow-2xs shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5 text-[#159447]" />
          </button>
        )}
        <button
          type="button"
          className="brand text-left bg-transparent border-0 p-0 min-h-[30px] cursor-pointer select-none"
          onClick={onBrandClick}
          title={lang === 'am' ? 'ADEYBINGO — መነሻ' : 'ADEYBINGO — Home'}
          aria-label="ADEYBINGO Home"
        >
          <b className="logo">A</b>
          <strong>
            ADEY<span>BINGO</span>
          </strong>
        </button>
      </div>

      <div className="actions">
        <button
          type="button"
          data-testid="header-timer"
          onClick={onTimerClick || onBrandClick}
          title={lang === 'am' ? 'የዙር ሰዓት ቆጣሪ · ወደ ጨዋታ ግባ' : 'Round timer · Enter live game'}
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
            className={`w-3 h-3 shrink-0 ${
              isLive ? 'text-[#F5BD42]' : isUrgent ? 'text-[#D99B20] animate-pulse' : 'text-[#159447]'
            }`}
          />
          <span className="font-mono tabular-nums font-extrabold">{countdownLabel}</span>
        </button>

        <button
          type="button"
          onClick={onWalletClick}
          title={lang === 'am' ? 'የእኔ ቦርሳ (ETB)' : 'My Wallet (ETB)'}
          aria-label={lang === 'am' ? 'የሙከራ ቦርሳ' : 'Demo Wallet'}
          className="!bg-[#FEF5DC] !border-[#F5BD42]/70 !text-[#183326]"
        >
          <Coins className="w-3 h-3 text-[#D99B20] shrink-0" />
          <span data-testid="home-demo-balance" className="tabular-nums font-extrabold text-[#183326]">
            {demoBalance.toFixed(2)} ETB
          </span>
        </button>

        <button
          type="button"
          data-testid="lang-toggle"
          onClick={onToggleLanguage}
          title={lang === 'am' ? 'Switch to English' : 'ወደ አማርኛ ቀይር'}
          aria-label="Switch language between Amharic and English"
        >
          <Globe className="w-3 h-3 text-[#159447] shrink-0" />
          <span>{lang === 'am' ? 'አማ' : 'EN'}</span>
        </button>

        {onToggleSound && (
          <button
            type="button"
            onClick={onToggleSound}
            title={sound ? (lang === 'am' ? 'ድምፅ አጥፋ' : 'Mute sound') : lang === 'am' ? 'ድምፅ አብራ' : 'Unmute sound'}
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
            title={lang === 'am' ? 'የአስተዳዳሪ ፓነል' : 'Owner Admin Panel'}
            aria-label="Owner Admin Panel"
            className={
              isAdminActive
                ? '!bg-[#159447] !text-white !border-[#08743A]'
                : '!bg-[#FEF5DC] !text-[#9A6B0B] !border-[#F5BD42]'
            }
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[#D99B20] shrink-0" />
            <span className="hidden sm:inline">{lang === 'am' ? 'አስተዳዳሪ' : 'Admin'}</span>
          </button>
        )}
      </div>
    </header>
  );
}

/* ============================================================================
 * 2. BalanceCard (Ultra-Compact Icon-First Balance & Bonus Card)
 * ========================================================================== */
export interface BalanceCardProps {
  label: string;
  amount: string | number;
  unit?: string;
  subtitle?: string;
  tooltip?: string;
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
  unit = 'ETB',
  subtitle,
  tooltip,
  variant = 'white',
  badgeText,
  icon,
  action,
  testId,
  className = '',
}: BalanceCardProps) {
  const styles = {
    emerald:
      'bg-gradient-to-br from-[#159447] to-[#08743A] text-white border-[#08743A] shadow-[0_4px_12px_rgba(21,148,71,0.16)]',
    gold: 'bg-gradient-to-br from-[#FEF5DC] via-[#FFF9ED] to-white text-[#183326] border-[#F5BD42]/60 shadow-[0_3px_10px_rgba(217,155,32,0.1)]',
    white:
      'bg-white text-[#183326] border-[#E7EDE8] shadow-[0_2px_8px_rgba(24,51,38,0.04)]',
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

  const effectiveTooltip = tooltip || subtitle;

  return (
    <div
      data-testid={testId}
      title={effectiveTooltip}
      className={`rounded-xl border p-2 sm:p-2.5 transition-all ${styles} ${className}`}
    >
      <div className="flex items-center justify-between gap-1">
        <div className={`text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 truncate ${labelColor}`}>
          {icon}
          <span className="truncate">{label}</span>
          {effectiveTooltip && (
            <CircleHelp className="w-2.5 h-2.5 opacity-70 shrink-0" aria-hidden="true" />
          )}
        </div>
        {badgeText && (
          <span
            className={`text-[8.5px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
              variant === 'emerald'
                ? 'bg-[#F5BD42] text-[#183326]'
                : 'bg-[#E6F6EB] text-[#08743A] border border-[#159447]/20'
            }`}
          >
            {badgeText}
          </span>
        )}
      </div>

      <div className="mt-0.5 flex items-baseline justify-between gap-1.5">
        <div className={`text-base sm:text-lg font-['Outfit'] font-extrabold tabular-nums leading-tight ${amountColor}`}>
          {typeof amount === 'number' ? amount.toLocaleString() : amount}{' '}
          {unit && (
            <span
              className={`text-[10px] font-bold ${
                variant === 'emerald' ? 'text-[#F5BD42]' : 'text-[#68776D]'
              }`}
            >
              {unit}
            </span>
          )}
        </div>
        {subtitle && !action && (
          <span className={`text-[9.5px] font-bold truncate ${variant === 'emerald' ? 'text-[#E6F6EB]/90' : 'text-[#68776D]'}`}>
            {subtitle}
          </span>
        )}
      </div>

      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

/* ============================================================================
 * 3. RewardCard (Ultra-Compact Referral & Bonus Card)
 * ========================================================================== */
export interface RewardCardProps {
  title: string;
  description?: string;
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
      title={description}
      className={`rounded-xl bg-gradient-to-br from-[#FFF9ED] via-white to-[#E6F6EB]/55 border border-[#F5BD42]/60 p-2 sm:p-2.5 shadow-[0_3px_10px_rgba(217,155,32,0.08)] ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#F5BD42] to-[#D99B20] text-[#183326] flex items-center justify-center shrink-0 shadow-[0_2px_6px_rgba(245,189,66,0.28)]">
            <Gift className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1">
              <h3 className="text-xs font-['Outfit'] font-extrabold text-[#183326] truncate">
                {title}
              </h3>
              {badge && (
                <span className="text-[9px] font-extrabold bg-[#F5BD42]/30 text-[#9A6B0B] border border-[#F5BD42] px-1.5 py-0.5 rounded">
                  {badge}
                </span>
              )}
            </div>
            {description && (
              <p className="text-[10px] text-[#68776D] truncate">{description}</p>
            )}
          </div>
        </div>

        {rewardHighlight && (
          <div className="bg-[#E6F6EB] border border-[#159447]/30 rounded-lg px-2 py-0.5 text-right shrink-0">
            <span className="text-[10.5px] font-['Outfit'] font-extrabold text-[#08743A] flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-[#D99B20]" />
              {rewardHighlight}
            </span>
          </div>
        )}
      </div>

      {children && <div className="mt-1.5">{children}</div>}

      {(onAction || secondaryAction) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
 * 5. BingoNumberTile (Ultra-Compact 1-600 Card Selection Tile)
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
    sm: 'min-h-[30px] sm:min-h-[32px] text-[10.5px] rounded-md',
    md: 'min-h-[34px] text-xs rounded-lg',
    lg: 'min-h-[38px] text-xs sm:text-sm rounded-xl',
  }[size];

  let stateClasses =
    'bg-white text-[#183326] border border-[#E7EDE8] hover:border-[#159447] hover:bg-[#E6F6EB]/55 shadow-[0_1px_2px_rgba(24,51,38,0.03)]';

  if (isSelected) {
    stateClasses = isSpecialGold
      ? 'bg-gradient-to-br from-[#159447] to-[#08743A] text-white border-2 border-[#F5BD42] ring-1 ring-[#F5BD42]/45 shadow-[0_3px_8px_rgba(21,148,71,0.22)] scale-[1.01]'
      : 'bg-gradient-to-br from-[#159447] to-[#08743A] text-white border border-[#08743A] shadow-[0_2px_6px_rgba(21,148,71,0.2)] scale-[1.01]';
  } else if (isTakenByOther) {
    stateClasses =
      'bg-[#FFF4F4] text-[#D94B4B]/65 border border-[#D94B4B]/25 cursor-not-allowed opacity-75';
  } else if (isSpecialGold) {
    stateClasses =
      'bg-[#FEF5DC]/80 text-[#183326] border border-[#F5BD42] hover:bg-[#FEF5DC] shadow-[0_1px_3px_rgba(245,189,66,0.12)]';
  }

  const statusText = isSelected
    ? 'Selected'
    : isTakenByOther
      ? 'Reserved'
      : isSpecialGold
        ? 'Lucky Gold'
        : 'Available';

  return (
    <button
      type="button"
      disabled={disabled || (!isSelected && isTakenByOther)}
      onClick={() => onSelect(cardNumber)}
      aria-pressed={isSelected}
      title={`#${cardNumber} · ${statusText}`}
      aria-label={`Bingo card ${cardNumber}${isSelected ? ' selected' : ''}${
        isTakenByOther ? ' reserved' : ''
      }`}
      className={`relative font-['Outfit'] font-extrabold tabular-nums flex flex-col items-center justify-center transition-all select-none active:scale-95 ${sizeClasses} ${stateClasses}`}
    >
      <span className="leading-none">{cardNumber}</span>
      {isSelected && selectedLabel && (
        <span className="text-[7.5px] font-bold uppercase tracking-tight text-[#F5BD42] mt-0.5 leading-none">
          {selectedLabel}
        </span>
      )}
      {!isSelected && isTakenByOther && takenLabel && (
        <span className="text-[7px] font-bold uppercase tracking-tight text-[#D94B4B] mt-0.5 leading-none">
          {takenLabel}
        </span>
      )}
      {isSelected && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[#F5BD42]"
        />
      )}
    </button>
  );
}

/* ============================================================================
 * 6. PrimaryButton & 7. SecondaryButton (Ultra-Compact 32-40px Touch Buttons)
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
      'bg-gradient-to-r from-[#159447] to-[#08743A] hover:from-[#16a04d] hover:to-[#098240] text-white border border-[#08743A] shadow-[0_3px_10px_rgba(21,148,71,0.22)]',
    gold: 'bg-gradient-to-r from-[#F5BD42] to-[#D99B20] hover:from-[#f7c555] hover:to-[#e0a326] text-[#183326] border border-[#D99B20] shadow-[0_3px_10px_rgba(245,189,66,0.24)]',
    danger:
      'bg-[#D94B4B] hover:bg-[#c53d3d] text-white border border-[#b83232] shadow-[0_3px_10px_rgba(217,75,75,0.2)]',
  }[variant];

  const sizeClasses = {
    sm: 'min-h-[32px] px-2.5 py-1 text-[11px] rounded-lg',
    md: 'min-h-[36px] px-3 py-1.5 text-xs rounded-xl',
    lg: 'min-h-[40px] px-3.5 py-1.5 text-xs sm:text-sm rounded-xl',
  }[size];

  return (
    <button
      type="button"
      disabled={disabled}
      className={`font-['Outfit'] font-extrabold inline-flex items-center justify-center gap-1.5 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${variantClasses} ${sizeClasses} ${
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
    sm: 'min-h-[32px] px-2.5 py-1 text-[11px] rounded-lg',
    md: 'min-h-[36px] px-3 py-1.5 text-xs rounded-xl',
    lg: 'min-h-[40px] px-3.5 py-1.5 text-xs sm:text-sm rounded-xl',
  }[size];

  return (
    <button
      type="button"
      disabled={disabled}
      className={`font-['Outfit'] font-bold bg-white hover:bg-[#E6F6EB] text-[#183326] hover:text-[#08743A] border border-[#E7EDE8] hover:border-[#159447]/40 shadow-[0_1px_4px_rgba(24,51,38,0.03)] inline-flex items-center justify-center gap-1.5 transition-all active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${sizeClasses} ${
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
  tooltip?: string;
}

export function GameStatusBadge({ status, label, pulse = false, tooltip }: GameStatusBadgeProps) {
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
      title={tooltip || label}
      className={`inline-flex items-center gap-1 text-[10px] font-extrabold px-2 py-0.5 rounded-full border whitespace-nowrap ${styles}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor} ${pulse ? 'animate-pulse' : ''}`}
      />
      <span>{label}</span>
    </span>
  );
}

/* ============================================================================
 * 9. BottomNavigation (Icon-First 4-Tab Bar: Home, Wallet, Play, Profile)
 * ========================================================================== */
export interface BottomNavigationProps {
  screen: ScreenId;
  lang: Language;
  onNavigate: (target: ScreenId) => void;
}

export function BottomNavigation({ screen, lang, onNavigate }: BottomNavigationProps) {
  const isHomeActive = screen === 'home' || screen === 'lobby' || screen === 'cards';
  const isWalletActive = screen === 'wallet' || screen === 'deposit' || screen === 'withdraw';
  const isPlayActive = screen === 'game';
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
        title={lang === 'am' ? 'መነሻ' : 'Home'}
        aria-label={lang === 'am' ? 'መነሻ' : 'Home'}
        className={isHomeActive ? 'selected' : ''}
        onClick={() => onNavigate('home')}
      >
        <Home className="w-4 h-4 shrink-0" />
        <span>{lang === 'am' ? 'መነሻ' : 'Home'}</span>
      </button>

      <button
        type="button"
        data-testid="nav-wallet"
        title={lang === 'am' ? 'ቦርሳ' : 'Wallet'}
        aria-label={lang === 'am' ? 'ቦርሳ' : 'Wallet'}
        className={isWalletActive ? 'selected' : ''}
        onClick={() => onNavigate('wallet')}
      >
        <Wallet className="w-4 h-4 shrink-0" />
        <span>{lang === 'am' ? 'ቦርሳ' : 'Wallet'}</span>
      </button>

      <button
        type="button"
        data-testid="nav-play"
        title={lang === 'am' ? 'ቢንጎ ጨዋታ' : 'Play Bingo'}
        aria-label={lang === 'am' ? 'ጨዋታ' : 'Play'}
        className={isPlayActive ? 'selected' : ''}
        onClick={() => onNavigate('game')}
      >
        <Gamepad2 className="w-4 h-4 shrink-0" />
        <span>{lang === 'am' ? 'ጨዋታ' : 'Play'}</span>
      </button>

      <button
        type="button"
        data-testid="nav-profile"
        title={lang === 'am' ? 'መገለጫ' : 'Profile'}
        aria-label={lang === 'am' ? 'መገለጫ' : 'Profile'}
        className={isProfileActive ? 'selected' : ''}
        onClick={() => onNavigate('profile')}
      >
        <User className="w-4 h-4 shrink-0" />
        <span>{lang === 'am' ? 'መገለጫ' : 'Profile'}</span>
      </button>
    </nav>
  );
}

/* ============================================================================
 * 10. EmptyState, 11. LoadingState, 12. ErrorState (Compact)
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
      title={description}
      className="rounded-xl bg-[#FFF9ED] border border-dashed border-[#159447]/30 p-3 text-center flex flex-col items-center justify-center"
    >
      {icon && (
        <div className="w-8 h-8 rounded-lg bg-[#E6F6EB] text-[#159447] flex items-center justify-center mb-1.5 shadow-2xs">
          {icon}
        </div>
      )}
      <h4 className="font-['Outfit'] font-extrabold text-xs text-[#183326]">{title}</h4>
      {description && (
        <p className="text-[10.5px] text-[#68776D] mt-0.5 max-w-xs leading-tight">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="rounded-xl bg-white border border-[#E7EDE8] p-3 text-center flex flex-col items-center justify-center shadow-xs">
      <Loader2 className="w-5 h-5 text-[#159447] animate-spin mb-1" />
      <p className="text-[11px] font-bold text-[#183326]">{label}</p>
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = 'Retry',
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="rounded-xl bg-[#FFF5F5] border border-[#D94B4B]/40 p-3 text-center flex flex-col items-center justify-center">
      <div className="w-8 h-8 rounded-lg bg-[#D94B4B]/15 text-[#D94B4B] flex items-center justify-center mb-1">
        <AlertCircle className="w-4 h-4" />
      </div>
      <h4 className="font-['Outfit'] font-extrabold text-xs text-[#183326]">{title}</h4>
      <p className="text-[10.5px] text-[#68776D] mt-0.5 max-w-xs">{message}</p>
      {onRetry && (
        <div className="mt-2">
          <PrimaryButton variant="danger" size="sm" onClick={onRetry}>
            {retryLabel}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}
