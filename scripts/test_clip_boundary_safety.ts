import assert from 'node:assert/strict';
import { addSpeechEndSafetyTail } from '../lib/clip-boundary-safety';

assert.equal(
  addSpeechEndSafetyTail({
    endSec: 38,
    segments: [{ start: 38.8, end: 41 }],
    sourceEndSec: 120,
    clipMaxEndSec: 60,
  }),
  38.55,
  'a normal sentence ending should retain enough post-roll for its final syllable',
);

assert.equal(
  addSpeechEndSafetyTail({
    endSec: 37,
    segments: [{ start: 37.05, end: 39 }],
    sourceEndSec: 120,
    clipMaxEndSec: 60,
  }),
  37.28,
  'touching ASR segments should still retain a minimum codec/timestamp safety tail',
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
