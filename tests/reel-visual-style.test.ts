import assert from 'node:assert/strict';
import test from 'node:test';
import { REEL_CAPTION_ACCENTS, resolveHookPlacement, resolveReelCaptionAccent } from '../lib/reel-visual-style';

test('caption accents are stable and limited to the approved green/yellow pair', () => {
  const first = resolveReelCaptionAccent('candidate-one');
  assert.equal(resolveReelCaptionAccent('candidate-one'), first);
  assert.ok(REEL_CAPTION_ACCENTS.includes(first));
  assert.ok(new Set(Array.from({ length: 40 }, (_, index) => resolveReelCaptionAccent(`candidate-${index}`))).size > 1);
});

test('context-heavy shots always keep the hook at the top', () => {
  assert.equal(resolveHookPlacement('one', { scene_type: 'screen_share' }), 'top');
  assert.equal(resolveHookPlacement('two', { recommended_layout: 'split_stack' }), 'top');
  assert.equal(resolveHookPlacement('three', { visual_context_required: true }), 'top');
});

test('only a stable subset of talking-head shots use upper-middle placement', () => {
  const placements = Array.from({ length: 60 }, (_, index) => resolveHookPlacement(`talking-${index}`, { scene_type: 'talking_head' }));
  assert.ok(placements.includes('top'));
  assert.ok(placements.includes('upper-middle'));
  assert.deepEqual(placements, Array.from({ length: 60 }, (_, index) => resolveHookPlacement(`talking-${index}`, { scene_type: 'talking_head' })));
});
