import assert from 'node:assert/strict';
import { CAPTION_FONTS, CAPTION_PRESETS } from '../lib/caption-presets';
import { buildDefaultClipEditSettings, normalizeClipEditSettings, phrasesToSegments } from '../lib/clip-edit';
import { segmentsToCapcutAss } from '../lib/srt';

assert.ok(CAPTION_PRESETS.length >= 8, 'caption picker should offer a focused template library');
assert.ok(new Set(CAPTION_PRESETS.map((preset) => preset.caption_template)).size >= 6, 'templates must be visually distinct, not color swaps');
assert.ok(new Set(CAPTION_PRESETS.map((preset) => preset.caption_font)).size >= 4, 'templates should demonstrate multiple bundled fonts');
assert.ok(CAPTION_FONTS.some((font) => font.id === 'poppins'));

const defaults = buildDefaultClipEditSettings({
  aiStart: 0,
  aiEnd: 4,
  sourceDuration: 4,
  transcriptPhrases: [{ id: 'one', start: 0, end: 4, text: 'Make it count', originalText: 'Make it count' }],
});
const settings = normalizeClipEditSettings({ ...defaults, caption_font: 'anton' }, defaults, 4);
assert.equal(settings.caption_font, 'anton', 'font override should survive saved-setting normalization');

const preset = CAPTION_PRESETS.find((item) => item.caption_font === 'anton');
assert.ok(preset);
const ass = segmentsToCapcutAss(
  [{ start: 0, end: 1.5, text: 'Make it count', words: [
    { start: 0, end: 0.4, word: 'Make' },
    { start: 0.4, end: 0.8, word: 'it' },
    { start: 0.8, end: 1.5, word: 'count' },
  ] }],
  0,
  1.5,
  preset,
);
assert.match(ass, /Style: Default,Anton,/, 'ASS export should use the chosen template font');
assert.match(ass, /Dialogue:/, 'ASS export should contain timed caption events');

const originalWords = [
  { start: 0, end: 0.22, word: 'Every' },
  { start: 0.22, end: 0.61, word: 'caption' },
  { start: 0.61, end: 0.94, word: 'stays' },
  { start: 0.94, end: 1.4, word: 'in' },
  { start: 1.4, end: 1.8, word: 'sync' },
];
const preserved = phrasesToSegments(
  [{ id: 'sync', start: 0, end: 1.8, text: 'Every caption stays in sync', originalText: 'Every caption stays in sync' }],
  [{ start: 0, end: 1.8, text: 'Every caption stays in sync', words: originalWords }],
);
assert.deepEqual(preserved[0]?.words, originalWords, 'unchanged edited captions must retain real word timestamps');

for (let maxWords = 1; maxWords <= 6; maxWords += 1) {
  const grouped = segmentsToCapcutAss(preserved, 0, 1.8, {
    ...CAPTION_PRESETS[0],
    captionMaxWords: maxWords,
  });
  const dialogueStarts = grouped
    .split('\n')
    .filter((line) => line.startsWith('Dialogue:'))
    .map((line) => line.split(',')[1]);
  assert.deepEqual(
    dialogueStarts,
    ['0:00:00.00', '0:00:00.22', '0:00:00.61', '0:00:00.94', '0:00:01.39'],
    `${maxWords} words per caption must preserve the same spoken-word boundaries`,
  );
}

console.log(`caption system: ${CAPTION_PRESETS.length} templates, ${CAPTION_FONTS.length} font choices`);
