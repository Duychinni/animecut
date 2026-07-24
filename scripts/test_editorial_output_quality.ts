import assert from 'node:assert/strict';
import {
  buildCandidateEditorialPlan,
  isEditorialCopyGrounded,
  isNaturalEditorialTitle,
  reusesSourceTitleAsEditorialPrefix,
} from '../lib/editorial-plan';

const brokenTitles = [
  "Why MrBeast Let's There's Matters",
  "Why MrBeast Let's Call Matters",
  'Why Battle First Pirates Matters',
  "Why Random Don't First Matters",
  "Inside MrBeast's MrBeast Games Show",
  "Leaves Another Message: I Didn't Realize You Had This Many People",
  'Leaves Another Message: 11, 12, 15, 14, 15, 17, 18',
  'Leaves Another Message: You Recorded This Video In 2015',
];

for (const title of brokenTitles) {
  assert.equal(isNaturalEditorialTitle(title), false, `expected broken title to fail: ${title}`);
}

const sourceTitleContext = [
  'Source title: MrBeast Counted to 100,000 in His First Viral Video, Leaves Another Message for Himself in 10 Years',
  'Project title: MrBeast Counted to 100,000 in His First Viral Video, Leaves Another Message for Himself in 10 Years',
].join('\n');
assert.equal(
  reusesSourceTitleAsEditorialPrefix(
    "Leaves Another Message: I Didn't Realize You Had This Many People",
    sourceTitleContext,
  ),
  true,
);
assert.equal(
  reusesSourceTitleAsEditorialPrefix(
    'MrBeast Lost 6,000 in a Single Moment',
    sourceTitleContext,
  ),
  false,
);

const transcript = [
  'MrBeast said his first viral video was counting to one hundred thousand.',
  'He spent forty hours recording it and the challenge changed his channel.',
].join(' ');

assert.equal(
  isEditorialCopyGrounded('MrBeast Counted to 100,000 for 40 Hours', transcript, 'Verified central subject: MrBeast.'),
  true,
);
assert.equal(
  isEditorialCopyGrounded('MrBeast Bought a Private Island', transcript, 'Verified central subject: MrBeast.'),
  false,
);

const plan = buildCandidateEditorialPlan({
  transcriptText: transcript,
  globalContext: `Verified central subject: MrBeast.\n${transcript}`,
  raw: {
    title: "Why MrBeast Let's There's Matters",
    hook_text: 'He Bought a Private Island',
    hook_options: [
      'He Bought a Private Island',
      'This Changed His Channel',
      'Forty Hours for One Video',
      'He Counted to 100,000',
      'The Challenge Went Viral',
    ],
  },
});

assert.equal(isNaturalEditorialTitle(plan.title), true);
assert.equal(isEditorialCopyGrounded(plan.title, transcript, 'MrBeast'), true);
assert.equal(isEditorialCopyGrounded(plan.selected_hook, transcript, 'MrBeast'), true);
assert.notEqual(plan.title, "Why MrBeast Let's There's Matters");
assert.notEqual(plan.selected_hook, 'He Bought a Private Island');

console.log('PASS editorial output quality');
