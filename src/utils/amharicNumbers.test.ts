import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBingoVoiceCallScript,
  numberToAmharicPhonetic,
  numberToAmharicWords,
} from './amharicNumbers.ts';

test('numberToAmharicWords converts all Bingo numbers 1..75 accurately', () => {
  assert.equal(numberToAmharicWords(1), 'አንድ');
  assert.equal(numberToAmharicWords(10), 'አስር');
  assert.equal(numberToAmharicWords(15), 'አስራ አምስት');
  assert.equal(numberToAmharicWords(20), 'ሃያ');
  assert.equal(numberToAmharicWords(35), 'ሰላሳ አምስት');
  assert.equal(numberToAmharicWords(42), 'አርባ ሁለት');
  assert.equal(numberToAmharicWords(58), 'ሃምሳ ስምንት');
  assert.equal(numberToAmharicWords(60), 'ስልሳ');
  assert.equal(numberToAmharicWords(75), 'ሰባ አምስት');

  for (let i = 1; i <= 75; i++) {
    const words = numberToAmharicWords(i);
    assert.ok(words.length > 0 && !/^\d+$/.test(words), `Expected Amharic words for ${i}, got ${words}`);
    const phonetic = numberToAmharicPhonetic(i);
    assert.ok(phonetic.length > 0 && !/^\d+$/.test(phonetic), `Expected phonetic words for ${i}`);
  }
});

test('getBingoVoiceCallScript maps B-I-N-G-O letters and Amharic phrases correctly', () => {
  const b5 = getBingoVoiceCallScript(5, 'am');
  assert.equal(b5.letter, 'B');
  assert.equal(b5.amharicText, 'ቢ፣ አምስት');
  assert.equal(b5.displayPhrase, 'ቢ አምስት');

  const g52 = getBingoVoiceCallScript(52, 'am');
  assert.equal(g52.letter, 'G');
  assert.equal(g52.amharicText, 'ጂ፣ ሃምሳ ሁለት');

  const o75 = getBingoVoiceCallScript(75, 'en');
  assert.equal(o75.letter, 'O');
  assert.equal(o75.englishText, 'O, 75');
  assert.equal(o75.displayPhrase, 'O-75');
});
