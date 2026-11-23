import type { RoomConfig } from '../types/bingo.ts';

export interface AuthoritativeRoomDefinition {
  id: string;
  nameAm: string;
  nameEn: string;
  subtitleAm: string;
  subtitleEn: string;
  cardPrice: number;
  maxPlayersPerRoom: number;
  maxCardsPerRoom: number;
  maxCardsPerPlayer: number;
  minPlayers: number;
  countdownSeconds: number;
  badgeAm: string;
  badgeEn: string;
}

/**
 * Single authoritative production room catalog for AdeyBingo.
 * Preserves exact room IDs, Amharic/English names, pricing (10 / 20 / 10 ETB),
 * capacity (600 players / 600 cards), max 4 cards per player, min 3 players,
 * and 60s registration countdown.
 *
 * Production rooms ALWAYS initialize cleanly in `countdown` with 0 active players
 * and 0 taken cards — never with fabricated demo player counts or fake live state.
 */
export const AUTHORITATIVE_PRODUCTION_ROOMS: readonly AuthoritativeRoomDefinition[] = [
  {
    id: 'adey-main',
    nameAm: 'አደይ ዋና አዳራሽ (Starter Room)',
    nameEn: 'Adey Main Hall (Starter)',
    subtitleAm: 'ፈጣን 60 ሰከንድ ሎቢ · ከ1–600 ካርዶች',
    subtitleEn: 'Fast 60s countdown · 1–600 cards deck',
    cardPrice: 10,
    maxPlayersPerRoom: 600,
    maxCardsPerRoom: 600,
    maxCardsPerPlayer: 4,
    minPlayers: 3,
    countdownSeconds: 60,
    badgeAm: 'በጣም ተወዳጅ',
    badgeEn: 'Most Popular',
  },
  {
    id: 'meskel-gold',
    nameAm: 'መስቀል ወርቃማ ክፍል (Classic)',
    nameEn: 'Meskel Gold Lounge (Classic)',
    subtitleAm: 'መካከለኛ ዙር · ከፍተኛ የሙከራ ሽልማት',
    subtitleEn: 'Classic pace · Higher demo pool',
    cardPrice: 20,
    maxPlayersPerRoom: 600,
    maxCardsPerRoom: 600,
    maxCardsPerPlayer: 4,
    minPlayers: 3,
    countdownSeconds: 60,
    badgeAm: '20 ETB / ካርድ',
    badgeEn: '20 ETB / Card',
  },
  {
    id: 'addis-express',
    nameAm: 'አዲስ ፈጣን ቢንጎ (Turbo)',
    nameEn: 'Addis Turbo Arena',
    subtitleAm: 'በየ 3 ሰከንድ ቁጥር የሚጠራበት ፈጣን ጨዋታ',
    subtitleEn: 'Rapid 3-second ball calls',
    cardPrice: 10,
    maxPlayersPerRoom: 600,
    maxCardsPerRoom: 600,
    maxCardsPerPlayer: 4,
    minPlayers: 3,
    countdownSeconds: 60,
    badgeAm: 'ፈጣን ዙር',
    badgeEn: 'Turbo Speed',
  },
] as const;

export function getAuthoritativeRoomDefinition(
  roomId: string
): AuthoritativeRoomDefinition | undefined {
  return AUTHORITATIVE_PRODUCTION_ROOMS.find((room) => room.id === roomId);
}

/**
 * Builds clean initial UI RoomConfig placeholders (zero fabricated players or taken cards)
 * used only before authoritative Firestore/API hydration completes.
 */
export function createCleanInitialRoomConfigs(): RoomConfig[] {
  return AUTHORITATIVE_PRODUCTION_ROOMS.map((room) => ({
    id: room.id,
    nameAm: room.nameAm,
    nameEn: room.nameEn,
    subtitleAm: room.subtitleAm,
    subtitleEn: room.subtitleEn,
    cardPrice: room.cardPrice,
    maxCardsPerRoom: room.maxCardsPerRoom,
    maxCardsPerPlayer: room.maxCardsPerPlayer,
    maxPlayers: room.maxPlayersPerRoom,
    minPlayers: room.minPlayers,
    countdownSeconds: room.countdownSeconds,
    activePlayers: 0,
    confirmedPlayersCount: 0,
    verifiedPaidEntriesCount: 0,
    availableSpaces: room.maxPlayersPerRoom,
    totalCardsSold: 0,
    totalCollectedEtb: 0,
    adeyShareEtb: 0,
    winnersPrizePoolEtb: 0,
    takenCardIds: [],
    status: 'countdown',
    lifecycleStage: 'WAITING',
    badgeAm: room.badgeAm,
    badgeEn: room.badgeEn,
  }));
}
