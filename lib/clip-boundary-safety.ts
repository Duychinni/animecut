export type TimedTranscriptSegment = {
  start?: number;
  end?: number;
};

const MIN_END_SAFETY_TAIL_SEC = 0.28;
const TARGET_END_SAFETY_TAIL_SEC = 0.55;

function finiteTime(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Transcript end timestamps describe recognized speech, not a safe edit point.
 * Keep a short amount of audio/video after the final recognized word so the
 * last syllable and sentence cadence cannot be clipped by timestamp or codec
 * rounding. When another transcript segment follows, avoid consuming more than
 * a tiny lead-in from that next thought.
 */
export function addSpeechEndSafetyTail(params: {
  endSec: number;
  segments: TimedTranscriptSegment[];
  sourceEndSec: number;
  clipMaxEndSec: number;
}) {
  const endSec = Math.max(0, finiteTime(params.endSec));
  const hardMax = Math.max(
    endSec,
    Math.min(
      finiteTime(params.sourceEndSec, endSec + TARGET_END_SAFETY_TAIL_SEC),
      finiteTime(params.clipMaxEndSec, endSec + TARGET_END_SAFETY_TAIL_SEC),
    ),
  );
  const nextSegment = params.segments
    .map((segment) => finiteTime(segment.start, Number.POSITIVE_INFINITY))
    .filter((start) => start >= endSec - 0.02)
    .sort((a, b) => a - b)[0];

  const targetEnd = Math.min(hardMax, endSec + TARGET_END_SAFETY_TAIL_SEC);
  if (!Number.isFinite(nextSegment)) return targetEnd;

  // Prefer ending in the available pause. If transcript timestamps touch or
  // overlap, retain a small protected tail because ASR boundaries commonly
  // underestimate the audible end of the last phoneme.
  const pauseSafeEnd = Math.max(
    endSec + MIN_END_SAFETY_TAIL_SEC,
    Math.min(targetEnd, nextSegment),
  );
  return Math.min(hardMax, pauseSafeEnd);
}

