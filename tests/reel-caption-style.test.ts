import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REEL_CAPTION_ACCENTS,
  resolveDefaultReelCaptionAccent,
  resolveDefaultReelHookPlacement,
} from '../lib/reel-caption-style';

test('default caption accent is stable and restricted to green, yellow, or purple', () => {
  const first = resolveDefaultReelCaptionAccent('candidate-one');
  assert.equal(resolveDefaultReelCaptionAccent('candidate-one'), first);
  assert.ok(DEFAULT_REEL_CAPTION_ACCENTS.includes(first));
});

test('default hook cards always stay at the top of the frame', () => {
  const placements = Array.from({ length: 120 }, (_, index) => resolveDefaultReelHookPlacement(`candidate-${index}`));
  assert.equal(placements.every((placement) => placement === 'top'), true);
});

test('default reels are split roughly evenly between green, bright yellow, and purple', () => {
  const accents = Array.from({ length: 300 }, (_, index) => resolveDefaultReelCaptionAccent(`candidate-${index}`));
  for (const accent of DEFAULT_REEL_CAPTION_ACCENTS) {
    const count = accents.filter((candidate) => candidate === accent).length;
    assert.ok(count >= 75 && count <= 125, `expected roughly one-third ${accent}, received ${count}/300`);
  }
});
