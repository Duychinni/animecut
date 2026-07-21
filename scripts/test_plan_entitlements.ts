import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getTargetClipCount } from '../lib/clip-policy';
import { buildPlanFeatures, PLAN_LOOKUP } from '../lib/plans';

assert.deepEqual(
  [PLAN_LOOKUP.starter.processingMinutes, PLAN_LOOKUP.creator.processingMinutes, PLAN_LOOKUP.pro.processingMinutes],
  [300, 800, 1500],
);
assert.deepEqual(
  [PLAN_LOOKUP.starter.maxUploadLengthMinutes, PLAN_LOOKUP.creator.maxUploadLengthMinutes, PLAN_LOOKUP.pro.maxUploadLengthMinutes],
  [60, 120, 180],
);
assert.deepEqual(
  [PLAN_LOOKUP.starter.maxGeneratedClips, PLAN_LOOKUP.creator.maxGeneratedClips, PLAN_LOOKUP.pro.maxGeneratedClips],
  [20, 25, 30],
);
assert.equal(getTargetClipCount(181 * 60), 30);

for (const plan of Object.values(PLAN_LOOKUP)) {
  assert.equal(buildPlanFeatures(plan).some((feature) => /additional source-video minutes/i.test(feature)), false);
}

const projectRoute = readFileSync(new URL('../app/api/projects/route.ts', import.meta.url), 'utf8');
const exportRoute = readFileSync(new URL('../app/api/clips/export/route.ts', import.meta.url), 'utf8');
const workerRoute = readFileSync(new URL('../app/api/jobs/process/route.ts', import.meta.url), 'utf8');
assert.match(projectRoute, /configuredPlan\.maxUploadLengthMinutes/);
assert.match(exportRoute, /entitlements\.maxGeneratedClips/);
assert.match(workerRoute, /sortProjectWorkByPlan/);

console.log('Plan entitlements are configured and enforced.');
