import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeKnownNames, editorialSourceContext, verifiedSourceSubjectHint } from '../lib/source-identity';
import { buildCandidateEditorialPlan } from '../lib/editorial-plan';

test('normalizes MrBeast branding from common source-title spelling', () => {
  assert.equal(canonicalizeKnownNames('How Mr. Beast Became Successful'), 'How MrBeast Became Successful');
  assert.match(verifiedSourceSubjectHint('How Mr. Beast Became Successful'), /Verified recognizable figures in source metadata: MrBeast/);
});

test('recognizes other notable figures without requiring their name in every reel', () => {
  const hint = verifiedSourceSubjectHint('Joe Rogan talks to Logan Paul and IShowSpeed');
  assert.match(hint, /Joe Rogan/);
  assert.match(hint, /Logan Paul/);
  assert.match(hint, /IShowSpeed/);
  assert.match(hint, /mix named and topic-led titles\/hooks/);
  assert.match(hint, /repeating it mechanically/);
  assert.match(hint, /recognition, search value, curiosity, or virality/);
});

test('does not invent a verified subject for an unrelated title', () => {
  assert.equal(verifiedSourceSubjectHint('How creators make videos'), '');
});

test('canonicalizes common Steven Seagal transcription variants', () => {
  assert.equal(canonicalizeKnownNames('Steve Seagel story'), 'Steven Seagal story');
  assert.equal(canonicalizeKnownNames('Steven Seagal fight'), 'Steven Seagal fight');
});

test('never sends an upload filename into editorial analysis', () => {
  assert.equal(editorialSourceContext({
    sourcePlatform: 'upload',
    sourceTitle: '2025-10-14 13-50-51.mp4',
    projectTitle: '2025-10-14 13-50-51',
    sourceChannelName: null,
  }), '');
});

test('keeps useful YouTube metadata as editorial context', () => {
  const context = editorialSourceContext({
    sourcePlatform: 'youtube',
    sourceTitle: 'Steven Seagel Changed Action Movies',
    projectTitle: null,
    sourceChannelName: 'Interview Archive',
  });
  assert.match(context, /Source title: Steven Seagal Changed Action Movies/);
  assert.match(context, /Source channel: Interview Archive/);
  assert.match(context, /Verified recognizable figures.*Steven Seagal/);
});

test('uses a transcript-proven person instead of timestamp numbers', () => {
  const plan = buildCandidateEditorialPlan({
    transcriptText: 'Steven Seagal told me he wanted to fight, but the whole challenge changed when we met in person.',
    globalContext: 'Steven Seagal told me he wanted to fight, but the whole challenge changed when we met in person.',
  });
  assert.match(`${plan.title} ${plan.selected_hook}`, /Steven Seagal/);
  assert.doesNotMatch(`${plan.title} ${plan.selected_hook}`, /\b14 13\b/);
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

test('repairs MrBeast hook fragments split by transcript boundaries', () => {
  const context = 'Source title: MrBeast Interview\nVerified central subject: MrBeast.';
  const trailingMr = buildCandidateEditorialPlan({
    transcriptText: 'How tall are you, Mr. Six two.',
    globalContext: context,
    raw: { title: 'MrBeast Reveals His Height', hook_text: 'How tall are you, Mr.' },
  });
  assert.equal(trailingMr.selected_hook, 'How tall are you, MrBeast');

  const leadingBeast = buildCandidateEditorialPlan({
    transcriptText: 'Beast came from, what, an Xbox?',
    globalContext: context,
    raw: { title: 'Where MrBeast Got His Name', hook_text: 'Beast came from, what, an Xbox?' },
  });
  assert.equal(leadingBeast.selected_hook, 'MrBeast came from, what, an Xbox?');
});
