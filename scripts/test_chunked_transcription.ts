import assert from 'node:assert/strict';
import { attachWordsToSegments, mergeChunkTranscripts } from '../lib/transcription';

const merged = mergeChunkTranscripts([
  {
    coreStart: 0,
    coreEnd: 10,
    extractionStart: 0,
    transcript: {
      language: 'en',
      fullText: 'first boundary duplicate',
      segments: [
        { start: 1, end: 2, text: 'first', words: [{ start: 1, end: 2, word: 'first' }] },
        { start: 9.5, end: 10.5, text: 'boundary duplicate' },
      ],
    },
  },
  {
    coreStart: 10,
    coreEnd: 20,
    extractionStart: 8,
    transcript: {
      language: 'en',
      fullText: 'boundary second',
      segments: [
        { start: 1.5, end: 2.5, text: 'boundary duplicate' },
        { start: 4, end: 5, text: 'second', words: [{ start: 4, end: 5, word: 'second' }] },
      ],
    },
  },
]);

assert.equal(merged.language, 'en');
assert.equal(merged.fullText, 'first boundary duplicate second');
assert.equal(merged.segments.length, 3);
assert.deepEqual(
  merged.segments.map((segment) => [segment.start, segment.end, segment.text]),
  [
    [1, 2, 'first'],
    [9.5, 10.5, 'boundary duplicate'],
    [12, 13, 'second'],
  ],
);
assert.deepEqual(merged.segments[2].words?.[0], { start: 12, end: 13, word: 'second' });

const boundaryMerged = mergeChunkTranscripts([
  {
    coreStart: 0,
    coreEnd: 10,
    extractionStart: 0,
    transcript: {
      language: 'en',
      fullText: 'before boundary',
      segments: [{
        start: 9,
        end: 11,
        text: 'before boundary',
        words: [
          { start: 9.2, end: 9.8, word: 'before' },
          { start: 10.1, end: 10.7, word: 'boundary' },
        ],
      }],
    },
  },
  {
    coreStart: 10,
    coreEnd: 20,
    extractionStart: 8,
    transcript: {
      language: 'en',
      fullText: 'before boundary',
      segments: [{
        start: 1.2,
        end: 2.7,
        text: 'before boundary',
        words: [
          { start: 1.2, end: 1.8, word: 'before' },
          { start: 2.1, end: 2.7, word: 'boundary' },
        ],
      }],
    },
  },
]);
assert.deepEqual(
  boundaryMerged.segments.flatMap((segment) => segment.words?.map((word) => word.word) ?? []),
  ['before', 'boundary'],
  'overlapping transcription chunks must assign every boundary word exactly once',
);

const attached = attachWordsToSegments(
  [
    { start: 0, end: 1, text: 'one two' },
    { start: 1, end: 2, text: 'three four' },
  ],
  [
    { start: 0.05, end: 0.3, word: 'one' },
    { start: 0.45, end: 0.8, word: 'two' },
    { start: 1.05, end: 1.3, word: 'three' },
    { start: 1.5, end: 1.9, word: 'four' },
  ],
);
assert.deepEqual(attached.map((segment) => segment.words?.map((word) => word.word)), [
  ['one', 'two'],
  ['three', 'four'],
]);

console.log('Chunked transcription timestamp merging and boundary deduplication passed.');
