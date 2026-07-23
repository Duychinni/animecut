import assert from 'node:assert/strict';
import {
  buildCandidateEditorialPlan,
  isEditorialCopyGrounded,
  isNaturalEditorialTitle,
} from '../lib/editorial-plan';

const brokenTitles = [
  "Why MrBeast Let's There's Matters",
  "Why MrBeast Let's Call Matters",
  'Why Battle First Pirates Matters',
  "Why Random Don't First Matters",
  "Inside MrBeast's MrBeast Games Show",
];

for (const title of brokenTitles) {
  assert.equal(isNaturalEditorialTitle(title), false, `expected broken title to fail: ${title}`);
}

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
