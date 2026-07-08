type TranscriptSegment = {
  start?: number;
  end?: number;
  text?: string;
};

function cleanText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function stripTrailingPunctuation(text: string) {
  return text.replace(/[\s.!?,;:]+$/g, '').trim();
}

function toTitleCaseHook(text: string) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^(UFC|AI|KO|POV|FAQ)$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function shortenWords(text: string, maxWords = 8, maxChars = 42) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    const next = [...kept, word].join(' ');
    if (kept.length >= maxWords || next.length > maxChars) break;
    kept.push(word);
  }
  return kept.join(' ');
}

function pickOpeningTranscript(segments: TranscriptSegment[], startSec: number, endSec: number) {
  const text = segments
    .filter((seg) => Number(seg.end ?? 0) >= startSec && Number(seg.start ?? 0) <= Math.min(endSec, startSec + 8))
    .map((seg) => cleanText(String(seg.text ?? '')))
    .filter(Boolean)
    .join(' ');
  return text;
}

export function generateHookText(params: {
  clipTitle?: string | null;
  transcriptSegments?: TranscriptSegment[] | null;
  startSec?: number;
  endSec?: number;
}) {
  const clipTitle = cleanText(String(params.clipTitle ?? ''));
  const startSec = Number(params.startSec ?? 0);
  const endSec = Number(params.endSec ?? 0);
  const openingTranscript = pickOpeningTranscript(params.transcriptSegments ?? [], startSec, endSec);

  const candidates = [
    stripTrailingPunctuation(clipTitle),
    stripTrailingPunctuation(openingTranscript),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const shortened = shortenWords(candidate, 8, 42);
    if (!shortened) continue;
    return toTitleCaseHook(shortened);
  }

  return null;
}
