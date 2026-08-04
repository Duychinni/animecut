export type TimedTranscriptSegment = {
  start?: number;
  end?: number;
};

export function preserveSemanticEndWhenExtendingShortClip(params: {
  startSec: number;
  endSec: number;
  minClipSec: number;
}) {
  const endSec = Math.max(0, finiteTime(params.endSec));
  const startSec = Math.max(0, Math.min(endSec, finiteTime(params.startSec)));
  const minClipSec = Math.max(0, finiteTime(params.minClipSec));
  if (endSec - startSec >= minClipSec) return { start: startSec, end: endSec };

  // The end of a completed answer/payoff is semantically stronger than a
  // duration target. Extend into the preceding setup first; padding forward
  // can consume the next question or story and produced visibly jumpy reels.
  return {
    start: Number(Math.max(0, endSec - minClipSec).toFixed(3)),
    end: endSec,
  };
}

const FINAL_WORD_RELEASE_SEC = 0.14;
const TARGET_END_SAFETY_TAIL_SEC = 0.32;

export function isTranscriptEndingFragment(text: string) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/[.!?,"”’']+$/g, '')
    .trim();
  if (!normalized) return true;
  if (/\b(and|but|because|so|if|when|while|where|that|which|who|to|for|with|about|from|into|of|or|as)$/i.test(normalized)) {
    return true;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  // ASR often punctuates a short continuation as its own sentence. Phrases
  // such as "to watch." are not valid editorial endings even though they have
  // a period; they belong to the preceding/following spoken thought.
  return words.length <= 5 && /^(and|but|because|if|when|while|where|to|for|with|about|from|into|of|or|as)\b/i.test(normalized);
}

function finiteTime(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Transcript end timestamps describe recognized speech, not a safe edit point.
 * Keep only a short codec/final-syllable release after the recognized ending.
 * Never use a minimum tail that can consume the opening words of the next
 * sentence when transcript segments touch.
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

  // End inside the pause when one exists. If the next sentence starts
  // immediately, allow only final-word release/codec rounding—not enough
  // post-roll to audibly begin the next thought.
  const sentenceSafeEnd = Math.min(
    targetEnd,
    Math.max(endSec, nextSegment - 0.04),
    endSec + FINAL_WORD_RELEASE_SEC,
  );
  return Math.min(hardMax, sentenceSafeEnd);
}
