import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReframeTimeline, resolveFaceAwareHookPlacement } from '../lib/ffmpeg';

test('does not center hooks from a split hint without a verified stacked timeline', () => {
  assert.equal(resolveFaceAwareHookPlacement('top', [], true), 'top');
});

test('keeps top placement for openings without a detected face', () => {
  assert.equal(resolveFaceAwareHookPlacement('top', [], false), 'top');
});

test('keeps solo hooks at the top even when the opening face is high in frame', () => {
  const timeline = [{
    start: 0,
    end: 5,
    mode: 'single' as const,
    points: [{
      t: 0,
      cropX: 0,
      cropY: 0,
      cropW: 1080,
      cropH: 1920,
      faceBox: { x: 100, y: 80, w: 300, h: 300 },
    }],
  }];

  assert.equal(resolveFaceAwareHookPlacement('top', timeline, false), 'top');
});

test('keeps hooks at the top when an opening face is below the hook card', () => {
  const timeline = [{
    start: 0,
    end: 5,
    mode: 'single' as const,
    points: [{
      t: 0,
      cropX: 0,
      cropY: 0,
      cropW: 1080,
      cropH: 1920,
      faceBox: { x: 100, y: 520, w: 300, h: 300 },
    }],
  }];

  assert.equal(resolveFaceAwareHookPlacement('top', timeline, true), 'top');
});

test('keeps serialized solo-face timelines at the top', () => {
  const timeline = normalizeReframeTimeline([{
    start: 0,
    end: 5,
    mode: 'single',
    points: [{
      t: 0,
      cropX: 0,
      cropY: 0,
      cropW: 1080,
      cropH: 1920,
      face_box: { x: 100, y: 80, w: 300, h: 300 },
    }],
  }], 5);

  assert.equal(timeline[0]?.points[0]?.faceBox?.w, 300);
  assert.equal(resolveFaceAwareHookPlacement('top', timeline, false), 'top');
});

test('places hooks on the divider for a verified stacked opening', () => {
  const timeline = [{
    start: 0,
    end: 5,
    mode: 'stacked' as const,
    points: [{
      t: 0,
      cropX: 0,
      cropY: 0,
      cropW: 1080,
      cropH: 1920,
    }],
  }];

  assert.equal(resolveFaceAwareHookPlacement('top', timeline, true), 'middle');
});
