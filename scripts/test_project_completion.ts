import assert from 'node:assert/strict';
import { hasSettledPlayableExports } from '../lib/project-completion';

assert.equal(hasSettledPlayableExports({
  totalExports: 10,
  doneExports: 7,
  failedExports: 3,
  activeExports: 0,
  activeJobs: 0,
  requiredPlayableExports: 7,
}), true, 'safe completed reels plus terminal rejected reels should finish the project');

assert.equal(hasSettledPlayableExports({
  totalExports: 12,
  doneExports: 1,
  failedExports: 11,
  activeExports: 0,
  activeJobs: 0,
  requiredPlayableExports: 12,
}), false, 'one successful reel must not complete a long project after the rest fail');

assert.equal(hasSettledPlayableExports({
  totalExports: 10,
  doneExports: 7,
  failedExports: 2,
  activeExports: 1,
  activeJobs: 1,
}), false, 'active rendering must keep the project open');

assert.equal(hasSettledPlayableExports({
  totalExports: 3,
  doneExports: 0,
  failedExports: 3,
  activeExports: 0,
  activeJobs: 0,
}), false, 'a project with no playable reels must not report completion');

console.log('PASS project completion reconciliation');
