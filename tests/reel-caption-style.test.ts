import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REEL_CAPTION_ACCENTS,
  resolveDefaultReelCaptionAccent,
} from '../lib/reel-caption-style';

test('default caption accent is stable and restricted to green or yellow', () => {
  const first = resolveDefaultReelCaptionAccent('candidate-one');
  assert.equal(resolveDefaultReelCaptionAccent('candidate-one'), first);
  assert.ok(DEFAULT_REEL_CAPTION_ACCENTS.includes(first));
});

test('yellow is an occasional variation rather than every other reel', () => {
  const accents = Array.from({ length: 120 }, (_, index) => resolveDefaultReelCaptionAccent(`candidate-${index}`));
  const yellow = accents.filter((accent) => accent === '#FFD84D').length;
  assert.ok(yellow >= 20 && yellow <= 40, `expected roughly 25% yellow accents, received ${yellow}/120`);
  assert.ok(accents.filter((accent) => accent === '#21F45A').length > yellow);
});
