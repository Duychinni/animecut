import assert from 'node:assert/strict';
import test from 'node:test';
import { hasClearFirstFiveSecondHook } from '../lib/opening-hook';

test('accepts openings that immediately establish a clear viral idea', () => {
  assert.equal(hasClearFirstFiveSecondHook('Why do UFC fighters hate the win bonus system?'), true);
  assert.equal(hasClearFirstFiveSecondHook('That spinning back kick nearly killed James Vick.'), true);
  assert.equal(hasClearFirstFiveSecondHook('I walked into a Serbian club and a man pulled out a grenade.'), true);
});

test('rejects delayed, vague, or context-dependent openings', () => {
  assert.equal(hasClearFirstFiveSecondHook('You know, the thing about it is we were talking about this.'), false);
  assert.equal(hasClearFirstFiveSecondHook('He was doing that for a while with them.'), false);
  assert.equal(hasClearFirstFiveSecondHook('Actually, let me tell you something first.'), false);
});
