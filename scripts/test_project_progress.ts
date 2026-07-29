import assert from 'node:assert/strict';
import { clampProgressToStage } from '../lib/project-progress';

assert.equal(clampProgressToStage(98, 'transcribing'), 44);
assert.equal(clampProgressToStage(98, 'rendering'), 96);
assert.equal(clampProgressToStage(94, 'rendering'), 94);
assert.equal(clampProgressToStage(100, 'transcribing', true), 100);
assert.equal(clampProgressToStage(100, 'transcribing'), 44);

console.log('Project progress tests passed.');
