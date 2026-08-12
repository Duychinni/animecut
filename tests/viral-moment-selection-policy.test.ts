import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const openAiSource = readFileSync(new URL('../lib/openai.ts', import.meta.url), 'utf8');
const localAnalysisSource = readFileSync(new URL('../lib/local-analysis.ts', import.meta.url), 'utf8');

test('podcast selection prioritizes complete viral MMA and emotional moments', () => {
  assert.match(openAiSource, /MMA, boxing, and combat-sports podcasts\/interviews/i);
  assert.match(openAiSource, /callouts, trash talk, rivalries, accusations, disagreements/i);
  assert.match(openAiSource, /humble, respectful, gracious, vulnerable, inspirational, or wholesome/i);
  assert.match(openAiSource, /setup or question, the central exchange\/story, the payoff, and the natural stopping point/i);
  assert.match(openAiSource, /first half or second half of an anecdote, argument, joke, answer, or emotional exchange/i);
});

test('boundary review rejects routine chatter and incomplete fight exchanges', () => {
  assert.match(openAiSource, /reject routine coherent chatter/i);
  assert.match(openAiSource, /Never approve only half of the fight story or verbal exchange/i);
});

test('local fallback rewards the same viral podcast signals', () => {
  assert.match(localAnalysisSource, /function hasPodcastViralTrigger/);
  assert.match(localAnalysisSource, /trash talk/);
  assert.match(localAnalysisSource, /humble/);
  assert.match(localAnalysisSource, /hasPodcastViralTrigger\(text\) && hasPayoff\(text\)/);
});
