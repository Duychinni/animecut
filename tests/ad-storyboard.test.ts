import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStoryboard } from '../lib/ad-storyboard';

test('normalizes and clamps AI storyboard scenes to the source', () => {
  const storyboard = normalizeStoryboard({
    hook: 'One video became five reels',
    scenes: [
      { sourceStart: -4, sourceEnd: 3, adDuration: 2, purpose: 'Hook', visual: 'Paste link', onScreenText: 'ONE LINK', voiceover: 'I pasted one link.' },
      { sourceStart: 98, sourceEnd: 140, adDuration: 20, purpose: 'Result', visual: 'Reels', onScreenText: 'DONE', voiceover: 'The reels appeared.' },
    ],
  }, { path: 'user/ad-assets/product-demo/video', name: 'Full video demo.mkv' }, 100);

  assert.equal(storyboard.assetName, 'Full video demo.mkv');
  assert.equal(storyboard.scenes[0].sourceStart, 0);
  assert.equal(storyboard.scenes[1].sourceEnd, 100);
  assert.equal(storyboard.scenes[1].adDuration, 8);
  assert.equal(storyboard.totalDuration, 10);
});
