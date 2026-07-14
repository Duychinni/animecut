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

function shortenWords(text: string, maxWords = 7, maxChars = 38) {
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

function hookPhraseScore(text: string) {
  const cleaned = cleanText(text);
  const words = cleaned.split(/\s+/).filter(Boolean);
  let score = 0;
  if (/\?/.test(cleaned) || /^(what|why|how|who|when|where|can|did|does|is|are|should|would|could)\b/i.test(cleaned)) score += 9;
  if (/[$%]|\b\d+(?:[.,]\d+)?\b/.test(cleaned)) score += 8;
  if (/\b(secret|truth|mistake|problem|wrong|never|can't|cannot|lost|broke|fight|knockout|shocking|risk|cost|reason|regret|threat|apology|accusation|debate|refused|million|thousand)\b/i.test(cleaned)) score += 7;
  if (/\b(but|until|unless|instead|actually|because|nobody|everyone|only)\b/i.test(cleaned)) score += 4;
  if (/\b(you|your)\b/i.test(cleaned)) score += 2;
  if (words.length >= 3 && words.length <= 9) score += 4;
  if (words.length < 3 || words.length > 12) score -= 5;
  if (/^(i think|i mean|you know|and|but|so|yeah|well|like)\b/i.test(cleaned)) score -= 5;
  if (/^(what do you mean|how old are you|would you have believed it|do you know what i mean)\??$/i.test(cleaned)) score -= 18;
  if (/\b(bet|versus|vs\.?|calls|refused|threat|challenge|risk|money|knockout|ducking|soft)\b/i.test(cleaned)) score += 6;
  if (/\b(and|but|because|if|when|where|which|who|to|for|with|about|from|into|of|or|as|the|is|are|was|were)\??$/i.test(cleaned)) score -= 14;
  if (/^(is|are|was|were)\s+(ducking|avoiding|fighting|betting|calling)\b/i.test(cleaned)) score -= 12;
  return score;
}

function editorialPremiseCandidates(text: string) {
  const cleaned = cleanText(text);
  const candidates: string[] = [];

  if (/\b(age|old)\b/i.test(cleaned) && /\b(bet|money|wager)\b/i.test(cleaned)) {
    candidates.push('Betting My Age Against Your Money?');
  }
  if (/\b(knockout|knock out|knock\s+(?:him|her|them)\s+out|ko)\b/i.test(cleaned)) {
    candidates.push('Can He Actually Get The Knockout?');
  }
  if (/\b(duck|ducking|avoid|avoiding)\b/i.test(cleaned) && /\b(fight|fighter|boxing|opponent)\b/i.test(cleaned)) {
    candidates.push('Is He Avoiding The Real Fight?');
    candidates.push('Why He Refused To Take The Fight');
  }
  if (/\b(soft|scared|afraid)\b/i.test(cleaned) && /\b(fight|fighter|boxing|opponent)\b/i.test(cleaned)) {
    candidates.push('The Accusation That Changed The Debate');
  }
  if (/\b(bet|money|wager|odds)\b/i.test(cleaned) && /\b(fight|fighter|boxing|wins?)\b/i.test(cleaned)) {
    candidates.push('Would You Bet Money On Him?');
  }
  if (/\b(disagree|argument|debate|back down|refused)\b/i.test(cleaned)) {
    candidates.push('Why Neither Side Backed Down');
  }

  return candidates;
}

function rankedHookCandidates(texts: string[]) {
  const candidates = texts.flatMap((text) => [
    ...editorialPremiseCandidates(text),
    ...derivedCuriosityCandidates(text),
    ...transcriptHookCandidates(text),
  ]);

  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const shortened = shortenWords(candidate, 9, 42);
    const key = normalizeForComparison(shortened);
    if (shortened && key && !unique.has(key)) unique.set(key, shortened);
  }

  return [...unique.values()]
    .map((text) => ({ text: toTitleCaseHook(text), score: hookPhraseScore(text) }))
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
}

function derivedCuriosityCandidates(text: string) {
  const cleaned = cleanText(text);
  const candidates: string[] = [];

  const timedResult = cleaned.match(/\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|\d+)\s+)?(?:days?|weeks?|months?|years?))\s+later\b[^.!?]*?\b(?:made|earned|reached|grew to)\s+([^.!?]+)/i);
  if (timedResult) candidates.push(`${timedResult[2]} In ${timedResult[1]}`);

  const testedResult = cleaned.match(/\b(?:we|i|they)\s+tested\s+([\w-]+)\s+([a-z][a-z-]*)[^.!?]*?\bonly\s+one\b(?:\s+of\s+them)?\s+(?:actually\s+)?([^.!?]+)/i);
  if (testedResult) candidates.push(`Only One Of ${testedResult[1]} ${testedResult[2]} ${testedResult[3]}`);

  const reversal = cleaned.match(/\bi\s+thought\s+(?:the\s+)?(.{2,28}?)\s+(?:would|was|had|ended|could)[^.!?]*[.!?]\s*instead,?\s+(?:it|that|this)\s+([^.!?]+)/i);
  if (reversal) candidates.push(`The ${reversal[1]} ${reversal[2]}`);

  const question = cleaned.match(/\b(?:what|why|how|who|when|where|can|did|does|is|are|should|would|could)\b[^?]{6,80}\?/i)?.[0];
  if (question) {
    candidates.push(question
      .replace(/\bmost\b\s*/i, '')
      .replace(/\btheir\s+videos?\b/gi, 'it')
      .replace(/\bfinally\b\s*/gi, '')
      .replace(/\bit\s+start\b/gi, 'it starts')
      .replace(/\s+/g, ' '));
  }

  return candidates
    .map((candidate) => stripTrailingPunctuation(removeWeakHookPrefix(candidate)))
    .map((candidate) => shortenWords(candidate, 9, 42))
    .filter(Boolean);
}

function transcriptHookCandidates(text: string) {
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

  const candidates = patterns
    .map((pattern) => cleaned.match(pattern)?.[0] ?? '')
    .concat(cleaned.split(/(?<=[.!?])\s+|\s+(?=but|until|unless|instead|because)\s*/i))
    .map((candidate) => stripTrailingPunctuation(removeWeakHookPrefix(candidate)))
    .map((candidate) => shortenWords(candidate, 9, 42))
    .filter((candidate, index, all) => candidate.split(/\s+/).length >= 3 && all.indexOf(candidate) === index);

  return candidates.sort((a, b) => hookPhraseScore(b) - hookPhraseScore(a));
}

export function generateHookTextFromText(text: string, clipTitle = '') {
  for (const candidate of rankedHookCandidates([text])) {
    const hook = candidate.text;
    if (!isTooSimilarToTitle(hook, clipTitle)) return hook;
  }
  return '';
}

export function generateHookOptionsFromText(text: string, clipTitle = '', limit = 5) {
  return rankedHookCandidates([text])
    .filter((candidate) => !isTooSimilarToTitle(candidate.text, clipTitle))
    .slice(0, Math.max(1, limit));
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

  // Score the whole reel before the opening so a stronger payoff, conflict, or
  // concrete result can beat a weak first sentence while staying transcript-grounded.
  const candidates = rankedHookCandidates([fullTranscript, openingTranscript, closingTranscript]);

  for (const candidate of candidates) {
    const shortened = shortenWords(candidate.text, 9, 42);
    if (!shortened) continue;
    const hook = toTitleCaseHook(shortened);
    if (!isTooSimilarToTitle(hook, clipTitle)) return hook;
  }

  return generateHookTextFromText(fullTranscript || openingTranscript, clipTitle) || 'Keep Watching For The Answer';
}
