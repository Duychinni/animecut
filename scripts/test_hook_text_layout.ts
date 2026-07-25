import assert from 'node:assert/strict';
import { wrapHookTextForDrawtext } from '../lib/ffmpeg';

for (const hook of [
  'How do you count for 40 hours?',
  'They live in a city, not hotels',
  'Why he almost switched from MrBeast6000',
  'What would you say to your future self?',
]) {
  const wrapped = wrapHookTextForDrawtext(hook);
  assert.equal(
    wrapped.replace(/\n/g, ' '),
    hook,
    `hook renderer must preserve every word: ${hook}`,
  );
  assert(wrapped.split('\n').length <= 3, `hook must fit within three lines: ${wrapped}`);
}

console.log('Hook text layout regression tests passed');
