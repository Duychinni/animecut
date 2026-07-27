import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getRequiredClipCount, getTargetClipCount } from '../lib/clip-policy';
import { buildPlanFeatures, PLAN_LOOKUP } from '../lib/plans';

assert.deepEqual(
  [PLAN_LOOKUP.starter.processingMinutes, PLAN_LOOKUP.creator.processingMinutes, PLAN_LOOKUP.pro.processingMinutes],
  [300, 800, 1500],
);
assert.deepEqual(
  [PLAN_LOOKUP.starter.maxUploadLengthMinutes, PLAN_LOOKUP.creator.maxUploadLengthMinutes, PLAN_LOOKUP.pro.maxUploadLengthMinutes],
  [60, 120, 300],
);
assert.deepEqual(
  [PLAN_LOOKUP.starter.maxGeneratedClips, PLAN_LOOKUP.creator.maxGeneratedClips, PLAN_LOOKUP.pro.maxGeneratedClips],
  [20, 25, 30],
);
const durationPolicy = [
  { minutes: 2, target: 4, required: 1 },
  { minutes: 5, target: 8, required: 3 },
  { minutes: 10, target: 12, required: 6 },
  { minutes: 20, target: 16, required: 10 },
  { minutes: 30, target: 18, required: 12 },
  { minutes: 47, target: 20, required: 15 },
  { minutes: 60, target: 20, required: 15 },
  { minutes: 90, target: 22, required: 17 },
  { minutes: 120, target: 25, required: 19 },
  { minutes: 180, target: 27, required: 21 },
  { minutes: 181, target: 30, required: 24 },
  { minutes: 300, target: 30, required: 24 },
];

for (const entry of durationPolicy) {
  assert.equal(getTargetClipCount(entry.minutes * 60), entry.target);
  assert.equal(getRequiredClipCount(entry.minutes * 60), entry.required);
}

for (let index = 1; index < durationPolicy.length; index += 1) {
  assert.ok(durationPolicy[index].target >= durationPolicy[index - 1].target);
  assert.ok(durationPolicy[index].required >= durationPolicy[index - 1].required);
}

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
