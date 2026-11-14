import { getLetterForNumber } from '../game/rules';
import { BingoLetter, Language } from '../types/bingo';

const AMHARIC_ONES: Record<number, string> = {
  1: 'አንድ',
  2: 'ሁለት',
  3: 'ሶስት',
  4: 'አራት',
  5: 'አምስት',
  6: 'ስድስት',
  7: 'ሰባት',
  8: 'ስምንት',
  9: 'ዘጠኝ',
};

const AMHARIC_TENS: Record<number, string> = {
  10: 'አስር',
  20: 'ሃያ',
  30: 'ሰላሳ',
  40: 'አርባ',
  50: 'ሃምሳ',
  60: 'ስልሳ',
  70: 'ሰባ',
};

const PHONETIC_ONES: Record<number, string> = {
  1: 'ahnd',
  2: 'hoo-let',
  3: 'sost',
  4: 'ah-raht',
  5: 'ahm-mist',
  6: 'sid-dist',
  7: 'sah-baht',
  8: 'sim-mint',
  9: 'zeh-teny',
};

const PHONETIC_TENS: Record<number, string> = {
  10: 'ah-sir',
  20: 'hah-yah',
  30: 'seh-lah-sah',
  40: 'ahr-bah',
  50: 'hahm-sah',
  60: 'sil-sah',
  70: 'seh-bah',
};

const AMHARIC_LETTER_NAMES: Record<BingoLetter, string> = {
  B: 'ቢ',
  I: 'አይ',
  N: 'ኤን',
  G: 'ጂ',
  O: 'ኦ',
};

const PHONETIC_LETTER_NAMES: Record<BingoLetter, string> = {
  B: 'Bee',
  I: 'Eye',
  N: 'En',
  G: 'Gee',
  O: 'Oh',
};

/**
 * Converts an integer 1..75 into natural spoken Amharic script words.
 */
export function numberToAmharicWords(n: number): string {
  const num = Math.floor(n);
  if (num < 1 || num > 75) return String(n);
  if (num < 10) return AMHARIC_ONES[num];
  if (num === 10) return AMHARIC_TENS[10];
  if (num < 20) return `አስራ ${AMHARIC_ONES[num - 10]}`;

  const tens = Math.floor(num / 10) * 10;
  const ones = num % 10;
  if (ones === 0) return AMHARIC_TENS[tens] || String(num);
  return `${AMHARIC_TENS[tens]} ${AMHARIC_ONES[ones]}`;
}

/**
 * Converts an integer 1..75 into phonetic Amharic for devices without an am-ET TTS voice.
 */
export function numberToAmharicPhonetic(n: number): string {
  const num = Math.floor(n);
  if (num < 1 || num > 75) return String(n);
  if (num < 10) return PHONETIC_ONES[num];
  if (num === 10) return PHONETIC_TENS[10];
  if (num < 20) return `ahs-rah ${PHONETIC_ONES[num - 10]}`;

  const tens = Math.floor(num / 10) * 10;
  const ones = num % 10;
  if (ones === 0) return PHONETIC_TENS[tens] || String(num);
  return `${PHONETIC_TENS[tens]} ${PHONETIC_ONES[ones]}`;
}

/**
 * Formats the full Bingo ball call in Amharic script, phonetic Amharic, and English.
 */
export function getBingoVoiceCallScript(
  ballNumber: number,
  lang: Language = 'am'
): {
  letter: BingoLetter;
  number: number;
  amharicText: string;
  amharicPhonetic: string;
  englishText: string;
  displayPhrase: string;
} {
  const letter = getLetterForNumber(ballNumber);
  const amWords = numberToAmharicWords(ballNumber);
  const phoneticWords = numberToAmharicPhonetic(ballNumber);
  const amharicText = `${AMHARIC_LETTER_NAMES[letter]}፣ ${amWords}`;
  const amharicPhonetic = `${PHONETIC_LETTER_NAMES[letter]}, ${phoneticWords}`;
  const englishText = `${letter}, ${ballNumber}`;
  return {
    letter,
    number: ballNumber,
    amharicText,
    amharicPhonetic,
    englishText,
    displayPhrase: lang === 'am' ? `${AMHARIC_LETTER_NAMES[letter]} ${amWords}` : `${letter}-${ballNumber}`,
  };
}
