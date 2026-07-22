import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REEL_CAPTION_ACCENTS,
  resolveDefaultReelCaptionAccent,
  resolveDefaultReelHookPlacement,
} from '../lib/reel-caption-style';

test('default caption accent is stable and restricted to green or yellow', () => {
  const first = resolveDefaultReelCaptionAccent('candidate-one');
  assert.equal(resolveDefaultReelCaptionAccent('candidate-one'), first);
  assert.ok(DEFAULT_REEL_CAPTION_ACCENTS.includes(first));
});

test('default hook cards always stay at the top of the frame', () => {
  const placements = Array.from({ length: 120 }, (_, index) => resolveDefaultReelHookPlacement(`candidate-${index}`));
  assert.equal(placements.every((placement) => placement === 'top'), true);
});

test('default reels are split roughly evenly between green and bright yellow', () => {
  const accents = Array.from({ length: 120 }, (_, index) => resolveDefaultReelCaptionAccent(`candidate-${index}`));
  const yellow = accents.filter((accent) => accent === '#FFFF00').length;
  assert.ok(yellow >= 48 && yellow <= 72, `expected roughly 50% yellow accents, received ${yellow}/120`);
  assert.equal(accents.filter((accent) => accent === '#21F45A').length + yellow, accents.length);
});
