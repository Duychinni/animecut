import assert from 'node:assert/strict';
import { mergeChunkTranscripts } from '../lib/transcription';

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

console.log('Chunked transcription timestamp merging and boundary deduplication passed.');
