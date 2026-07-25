import assert from 'node:assert/strict';
import { addSpeechEndSafetyTail, isTranscriptEndingFragment } from '../lib/clip-boundary-safety';

assert.equal(
  addSpeechEndSafetyTail({
    endSec: 38,
    segments: [{ start: 38.8, end: 41 }],
    sourceEndSec: 120,
    clipMaxEndSec: 60,
  }),
  38.14,
  'a normal sentence ending should use only a short final-word release',
);

assert.equal(
  addSpeechEndSafetyTail({
    endSec: 37,
    segments: [{ start: 37.05, end: 39 }],
    sourceEndSec: 120,
    clipMaxEndSec: 60,
  }),
  37.01,
  'touching ASR segments must not audibly begin the next sentence',
);

assert.equal(
  addSpeechEndSafetyTail({
    endSec: 52.8,
    segments: [],
    sourceEndSec: 53,
    clipMaxEndSec: 70,
  }),
  53,
  'the safety tail must never pass the source ending',
);

assert.equal(
  addSpeechEndSafetyTail({
    endSec: 59.8,
    segments: [],
    sourceEndSec: 120,
    clipMaxEndSec: 60,
  }),
  60,
  'the safety tail must respect the maximum clip window',
);

console.log('clip boundary safety tests passed');

assert.equal(isTranscriptEndingFragment('to watch.'), true, 'ASR punctuation must not approve a short infinitive fragment');
assert.equal(isTranscriptEndingFragment('because of what happened.'), true, 'dependent fragments must not end a reel');
assert.equal(isTranscriptEndingFragment('This is going to be amazing to watch.'), false, 'a complete sentence should remain valid');
assert.equal(isTranscriptEndingFragment('That is the whole story.'), false, 'a clean story ending should remain valid');
