import assert from 'node:assert/strict';
import { clampProgressToStage, getPublicPipelineStageLabel } from '../lib/project-progress';

assert.equal(clampProgressToStage(98, 'transcribing'), 44);
assert.equal(clampProgressToStage(98, 'rendering'), 96);
assert.equal(clampProgressToStage(94, 'rendering'), 94);
assert.equal(clampProgressToStage(100, 'transcribing', true), 100);
assert.equal(clampProgressToStage(100, 'transcribing'), 44);
assert.equal(
  getPublicPipelineStageLabel('transcribing', 'Transcribing audio (3/3)'),
  'Transcribing audio',
);
assert.equal(
  getPublicPipelineStageLabel('rendering', 'Rendering reels (2/15 READY)'),
  'Rendering reels (2/15 READY)',
);

console.log('Project progress tests passed.');
