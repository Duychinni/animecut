import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeKnownNames, verifiedSourceSubjectHint } from '../lib/source-identity';
import { buildCandidateEditorialPlan } from '../lib/editorial-plan';

test('normalizes MrBeast branding from common source-title spelling', () => {
  assert.equal(canonicalizeKnownNames('How Mr. Beast Became Successful'), 'How MrBeast Became Successful');
  assert.match(verifiedSourceSubjectHint('How Mr. Beast Became Successful'), /Verified central subject: MrBeast/);
});

test('does not invent a verified subject for an unrelated title', () => {
  assert.equal(verifiedSourceSubjectHint('How creators make videos'), '');
});

test('uses verified MrBeast identity for a local origin-story fallback', () => {
  const plan = buildCandidateEditorialPlan({
    transcriptText: 'I started YouTube when I was 11 and made a dollar a day. I reinvested every dollar into videos for years.',
    globalContext: 'Source title: How MrBeast Became Successful\nVerified central subject: MrBeast.',
    raw: { title: 'YouTube Explains Making Money', hook_text: 'The Making Money Detail Most People Miss' },
  });
  assert.equal(plan.title, 'MrBeast Reinvested Every Dollar for Years');
  assert.equal(plan.selected_hook, 'He Started YouTube at Just 11');
});
