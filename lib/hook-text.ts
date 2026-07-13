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
  return text.replace(/[\s.,;:]+$/g, '').trim();
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

function shortenWords(text: string, maxWords = 6, maxChars = 28) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    const next = [...kept, word].join(' ');
    if (kept.length >= maxWords || next.length > maxChars) break;
    kept.push(word);
  }
  return kept.join(' ');
}

function removeWeakHookPrefix(text: string) {
  return text
    .replace(/^(the\s+)?(hook|moment|clip|short|reel)\s+(that|where|when|about)\s+/i, '')
    .replace(/^(why|how)\s+this\s+moment\s+/i, '')
    .trim();
}

function pickOpeningTranscript(segments: TranscriptSegment[], startSec: number, endSec: number) {
  const text = segments
    .filter((seg) => Number(seg.end ?? 0) >= startSec && Number(seg.start ?? 0) <= Math.min(endSec, startSec + 8))
    .map((seg) => cleanText(String(seg.text ?? '')))
    .filter(Boolean)
    .join(' ');
  return text;
}

function pickTranscriptRange(segments: TranscriptSegment[], startSec: number, endSec: number) {
  return segments
    .filter((seg) => Number(seg.end ?? 0) >= startSec && Number(seg.start ?? 0) <= endSec)
    .map((seg) => cleanText(String(seg.text ?? '')))
    .filter(Boolean)
    .join(' ');
}

function normalizeForComparison(text: string) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTooSimilarToTitle(hook: string, title: string) {
  const normalizedHook = normalizeForComparison(hook);
  const normalizedTitle = normalizeForComparison(title);
  if (!normalizedHook || !normalizedTitle) return false;
  if (normalizedHook === normalizedTitle) return true;
  if (normalizedHook.length >= 10 && normalizedTitle.includes(normalizedHook)) return true;
  if (normalizedTitle.length >= 10 && normalizedHook.includes(normalizedTitle)) return true;

  const hookWords = normalizedHook.split(' ').filter((word) => word.length > 2);
  const titleWords = new Set(normalizedTitle.split(' ').filter((word) => word.length > 2));
  if (hookWords.length < 3 || !titleWords.size) return false;
  return hookWords.filter((word) => titleWords.has(word)).length / hookWords.length >= 0.7;
}

function pickTranscriptHookPhrase(text: string) {
  const cleaned = cleanText(text)
    .replace(/^["'\-:\s]+/, '')
    .replace(/^(and|but|so|yeah|well|like|you know|i mean)\s+/i, '')
    .trim();

  const patterns = [
    /\b(what|why|how|who|when|where|can|did|does|is|are|should|would|could)\b[^.!?]{6,54}[?!]?/i,
    /\b(i|you|we|he|she|they|my|your|his|her|their)\b[^.!?]{4,54}\b(fight|hit|lost|remember|woke|broke|wrong|real|never|can't|cannot|right|okay)\b[^.!?]{0,20}/i,
    /\b(fight|hit|knockout|hospital|memory|lost|secret|truth|problem|crazy|wild|wrong|never|can't|cannot|broke|shocking)\b[^.!?]{0,52}/i,
    /\b(my|your|his|her|their|daughter|son|mom|dad|brother|friend)\b[^.!?]{6,54}/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern)?.[0];
    const shortened = shortenWords(match ?? '', 8, 38);
    if (shortened) return shortened;
  }

  return shortenWords(cleaned, 8, 38);
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
  const fullTranscript = pickTranscriptRange(params.transcriptSegments ?? [], startSec, endSec);
  const closingTranscript = pickTranscriptRange(
    params.transcriptSegments ?? [],
    Math.max(startSec, endSec - 12),
    endSec,
  );

  const candidates = [openingTranscript, fullTranscript, closingTranscript]
    .map((text) => stripTrailingPunctuation(pickTranscriptHookPhrase(text)))
    .map(removeWeakHookPrefix)
    .filter(Boolean);

  for (const candidate of candidates) {
    const shortened = shortenWords(candidate, 8, 38);
    if (!shortened) continue;
    const hook = toTitleCaseHook(shortened);
    if (!isTooSimilarToTitle(hook, clipTitle)) return hook;
  }

  return 'This Is The Part That Matters';
}
