import assert from 'node:assert/strict';
import test from 'node:test';
import { editorialExclusionReason } from '../lib/editorial-exclusions';

test('rejects a podcast introduction near the beginning', () => {
  assert.equal(editorialExclusionReason({
    text: 'Welcome back to the Joe Rogan Experience. My guest today is an incredible fighter.',
    startSec: 8,
    endSec: 52,
    totalSeconds: 3600,
  }), 'intro_or_cold_open');
});

test('does not reject substantive content merely because it starts early', () => {
  assert.equal(editorialExclusionReason({
    text: 'The hardest part of becoming a champion was learning how to lose without making excuses.',
    startSec: 5,
    endSec: 48,
    totalSeconds: 3600,
  }), null);
});

test('rejects calls to subscribe and sign-offs near the end', () => {
  assert.equal(editorialExclusionReason({
    text: 'Thanks for watching. Do not forget to like and subscribe, and we will see you next time.',
    startSec: 3520,
    endSec: 3595,
    totalSeconds: 3600,
  }), 'outro_or_end_card');
});

test('does not reject a meaningful payoff near the end', () => {
  assert.equal(editorialExclusionReason({
    text: 'That is why the experiment failed, and the lesson changed how we built every version afterward.',
    startSec: 3520,
    endSec: 3595,
    totalSeconds: 3600,
  }), null);
});

test('rejects sponsor reads anywhere in the source', () => {
  assert.equal(editorialExclusionReason({
    text: 'A quick word from our sponsor. Use promo code ROGAN for twenty percent off at checkout.',
    startSec: 1800,
    endSec: 1840,
    totalSeconds: 3600,
  }), 'sponsor_or_promotional_break');
});

test('rejects intermissions and transition breaks anywhere in the source', () => {
  assert.equal(editorialExclusionReason({
    text: 'We will be right back after this break. Stay tuned for the rest of the conversation.',
    startSec: 900,
    endSec: 930,
    totalSeconds: 3600,
  }), 'recap_or_transition_break');
});

test('does not mistake a substantive discussion of taking breaks for packaging', () => {
  assert.equal(editorialExclusionReason({
    text: 'Taking a break from training helped me recover, and I came back stronger the next season.',
    startSec: 900,
    endSec: 945,
    totalSeconds: 3600,
  }), null);
});
