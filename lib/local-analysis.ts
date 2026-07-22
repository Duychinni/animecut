import { getClipPolicy, getTargetClipCount } from '@/lib/clip-policy';
import { generateHookTextFromText } from '@/lib/hook-text';
import { buildCandidateEditorialPlan } from '@/lib/editorial-plan';
import { editorialExclusionReason } from '@/lib/editorial-exclusions';

type TranscriptSegment = {
  start?: number;
  end?: number;
  text?: string;
};

function cleanText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function segmentStart(segment: TranscriptSegment) {
  const value = Number(segment.start ?? 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function segmentEnd(segment: TranscriptSegment) {
  const start = segmentStart(segment);
  const value = Number(segment.end ?? start);
  return Number.isFinite(value) ? Math.max(start, value) : start;
}

function wordCount(text: string) {
  return cleanText(text).split(/\s+/).filter(Boolean).length;
}

function phraseFromText(text: string, maxWords = 7, maxChars = 48) {
  const cleaned = cleanText(text)
    .replace(/^["'\-\u2013\u2014\s]+/, '')
    .replace(/^(and|but|so|yeah|well|like|you know)\s+/i, '');
  const words = cleaned.split(/\s+/).filter(Boolean);
  const picked: string[] = [];

  for (const word of words) {
    const next = [...picked, word].join(' ');
    if (picked.length >= maxWords || next.length > maxChars) break;
    picked.push(word);
  }

  const phrase = picked.join(' ').replace(/[,:;.\-]+$/, '');
  return phrase ? phrase[0].toUpperCase() + phrase.slice(1) : '';
}

const TITLE_STOPWORDS = new Set([
  'about',
  'actually',
  'again',
  'because',
  'before',
  'being',
  'could',
  'every',
  'from',
  'going',
  'gonna',
  'have',
  'here',
  'just',
  'know',
  'like',
  'look',
  'maybe',
  'really',
  'right',
  'said',
  'should',
  'something',
  'that',
  'their',
  'there',
  'thing',
  'think',
  'this',
  'those',
  'through',
  'want',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
  'yeah',
  'your',
]);

function titleCasePhrase(text: string) {
  return cleanText(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function keywordTitle(text: string, index: number) {
  const cleaned = cleanText(text);
  if (/\b(flat earth|earth|planet|moon|space|gravity)\b/i.test(cleaned)) return 'The Evidence Behind the Flat Earth Debate';
  if (/\b(fight|ufc|boxing|knockout|rematch|fighter|opponent)\b/i.test(cleaned)) {
    if (/\b(bet|money|odds|wager)\b/i.test(cleaned)) return 'The Fight Bet They Could Not Agree On';
    if (/\b(knockout|knock out|ko)\b/i.test(cleaned)) return 'The Knockout Claim Behind the Debate';
    if (/\b(duck|soft|scared|afraid|avoid)\b/i.test(cleaned)) return 'The Accusation Dividing the Fight Debate';
    return 'The Fight Prediction They Disagree On';
  }
  if (/\b(song|music|producer|album|record|studio)\b/i.test(cleaned)) return 'The Decision That Changed the Music Story';
  if (/\b(podcast|interview|question|answer)\b/i.test(cleaned)) return 'The Question That Changed the Conversation';
  if (/\b(truth|secret|mistake|problem|wrong|realized)\b/i.test(cleaned)) return 'The Realization That Changed Their View';

  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !TITLE_STOPWORDS.has(word));
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const keywords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([word]) => word);

  if (keywords.length >= 2) return `Why ${titleCasePhrase(keywords.join(' '))} Matters`;
  return `A Conversation Worth Hearing ${index + 1}`;
}

function titleFromTranscript(text: string, index: number) {
  return keywordTitle(cleanText(text), index);
}

function hookTextFromTranscript(text: string, fallback: string) {
  const viralHook = generateHookTextFromText(text, fallback);
  if (viralHook) return viralHook;
  const cleaned = cleanText(text)
    .replace(/^["'\-\u2013\u2014\s]+/, '')
    .replace(/^(and|but|so|yeah|well|like|you know|i mean)\s+/i, '');

  const question = cleaned.match(/\b(why|what|how|who|when|where|can|did|does|is|are)\b[^.!?]{8,42}[?!]?/i)?.[0];
  const tension = cleaned.match(/\b(secret|truth|mistake|problem|crazy|wild|never|always|wrong|fight|shocking|realized)\b[^.!?]{0,36}/i)?.[0];
  const personal = cleaned.match(/\b(my|your|his|her|their|daughter|son|mom|dad|brother|friend)\b[^.!?]{6,42}/i)?.[0];
  const hook = phraseFromText(question || tension || personal || cleaned, 7, 38);
  const normalize = (value: string) => cleanText(value).toLowerCase().replace(/[^a-z0-9\s]/g, '');
  if (hook && normalize(hook) !== normalize(fallback)) return hook;
  return phraseFromText(cleaned, 8, 42) || 'Keep Watching For The Answer';
}

function hasTension(text: string) {
  return /\?|!|\b(why|how|what|when|where|who|can|should|would|could|did|does|problem|mistake|secret|truth|wrong|crazy|wild|hard|never|always)\b/i.test(
    text,
  );
}

function hasPayoff(text: string) {
  return /\b(because|but|so|then|that is why|that's why|the point|the thing|realized|actually|finally|important|answer|reason|lesson|learned)\b/i.test(
    text,
  );
}

function hasFillerStart(text: string) {
  return /^(and|but|so|yeah|well|like|you know)\b/i.test(cleanText(text));
}

function endsSentence(text: string) {
  return /[.!?]["']?$/.test(cleanText(text));
}

function hasReliableSentencePunctuation(segments: TranscriptSegment[]) {
  const sampled = segments
    .map((segment) => cleanText(segment.text ?? ''))
    .filter((text) => wordCount(text) >= 3)
    .slice(0, 320);

  if (sampled.length < 8) return true;
  const punctuated = sampled.filter((text) => endsSentence(text)).length;
  return punctuated / sampled.length >= 0.16;
}

function overlapsSelected(start: number, end: number, selected: Array<{ start: number; end: number }>) {
  return selected.some((item) => {
    const overlap = Math.max(0, Math.min(end, item.end) - Math.max(start, item.start));
    const minDur = Math.max(1, Math.min(end - start, item.end - item.start));
    return overlap >= 12 && overlap / minDur >= 0.78;
  });
}

function labelForText(text: string) {
  if (/\b(why|what|how|secret|truth|crazy|wild|never)\b/i.test(text)) return 'Hook';
  if (/\b(because|lesson|learned|reason|point|tip|advice|answer)\b/i.test(text)) return 'Educational';
  if (/\b(felt|love|hate|scared|angry|happy|sad|family|daughter|son|mom|dad)\b/i.test(text)) return 'Story';
  return 'Viral';
}

function scoreWindow(text: string, duration: number, startsWithFiller: boolean) {
  const words = wordCount(text);
  let score = 70;

  if (hasTension(text)) score += 9;
  if (hasPayoff(text)) score += 8;
  if (duration >= 24 && duration <= 65) score += 6;
  if (words >= 45 && words <= 180) score += 5;
  if (/[!?]/.test(text)) score += 4;
  if (/\b(I|me|my|you|your|we|us)\b/i.test(text)) score += 3;
  if (startsWithFiller) score -= 5;
  if (words < 20) score -= 8;

  return Math.max(70, Math.min(96, Math.round(score)));
}

function segmentsInWindow(segments: TranscriptSegment[], start: number, end: number) {
  return segments.filter((segment) => segmentEnd(segment) > start && segmentStart(segment) < end);
}

function textForWindow(segments: TranscriptSegment[], start: number, end: number, transcript: string) {
  const windowSegments = segmentsInWindow(segments, start, end);
  const text = cleanText(windowSegments.map((segment) => segment.text ?? '').join(' '));
  return text || cleanText(transcript).slice(0, 600);
}

function candidateStarts(totalSeconds: number, count: number, windowSeconds: number) {
  const usableSeconds = Math.max(windowSeconds, totalSeconds - windowSeconds);
  const spacing = Math.max(8, usableSeconds / Math.max(1, count));

  return Array.from({ length: count }, (_, index) => {
    const offset = index % 2 === 0 ? 0 : spacing * 0.33;
    return Math.min(Math.max(0, index * spacing + offset), Math.max(0, totalSeconds - windowSeconds));
  });
}

function openingLine(text: string) {
  const firstSentence = cleanText(text).split(/(?<=[.!?])\s+/)[0] ?? text;
  return cleanText(firstSentence).slice(0, 180);
}

function closingLine(text: string) {
  const sentences = cleanText(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  return cleanText(sentences[sentences.length - 1] ?? text).slice(0, 180);
}

export function analyzeTranscriptLocally(
  transcript: string,
  segments: TranscriptSegment[] = [],
  sourceContext = '',
) {
  const realSegments = segments
    .map((segment) => ({
      start: segmentStart(segment),
      end: segmentEnd(segment),
      text: cleanText(segment.text ?? ''),
    }))
    .filter((segment) => segment.end > segment.start && segment.text);

  const totalSeconds =
    realSegments.reduce((max, segment) => Math.max(max, segment.end), 0) ||
    Math.max(120, Math.ceil(wordCount(transcript) / 2.7));
  const policy = getClipPolicy(totalSeconds);
  const targetCount = getTargetClipCount(totalSeconds);
  const windowSeconds = Math.max(
    policy.expectedMinSec,
    Math.min(policy.expectedMaxSec, Math.round((policy.expectedMinSec + policy.expectedMaxSec) / 2)),
  );
  const desiredPool = Math.max(policy.candidateCount, targetCount * 3, policy.targetMin * 3);
  const punctuationReliable = hasReliableSentencePunctuation(realSegments);

  const rawCandidates = candidateStarts(totalSeconds, desiredPool, windowSeconds).map((start, index) => {
    const end = Math.min(totalSeconds, start + windowSeconds);
    const text = textForWindow(realSegments, start, end, transcript);
    const duration = Math.max(1, end - start);
    const score = scoreWindow(text, duration, hasFillerStart(text));
    const legacyTitle = titleFromTranscript(text, index);
    const legacyHook = hookTextFromTranscript(text, legacyTitle);
    const editorialPlan = buildCandidateEditorialPlan({
      transcriptText: text,
      globalContext: [sourceContext, transcript].filter(Boolean).join('\n'),
      fallbackTitle: legacyTitle,
      fallbackHook: legacyHook,
    });

    return {
      title: editorialPlan.title,
      hook_text: editorialPlan.selected_hook,
      hook_options: editorialPlan.hook_options,
      hook_supporting_quote: editorialPlan.hook_options[0].supporting_quote,
      hook_selection_reason: editorialPlan.hook_options[0].reason,
      story: editorialPlan.story,
      conflict: editorialPlan.conflict,
      primary_speaker: editorialPlan.primary_speaker,
      supporting_speakers: editorialPlan.supporting_speakers,
      visual_context_required: editorialPlan.visual_context_required,
      scene_type: editorialPlan.scene_type,
      recommended_layout: editorialPlan.recommended_layout,
      recommended_thumbnail: editorialPlan.recommended_thumbnail,
      topic: editorialPlan.topic,
      moment_type: editorialPlan.moment_type,
      virality_reason: editorialPlan.virality_reason,
      editorial_plan: editorialPlan,
      raw_start: start,
      raw_end: end,
      adjusted_start: start,
      adjusted_end: end,
      duration_seconds: duration,
      analysis_provider: 'local',
      reason_selected:
        'Selected from the real transcript by local analysis so the render pipeline can be tested without OpenAI usage.',
      reason_rejected: null,
      boundary_adjustment_reason: 'Aligned to a transcript window near the selected moment.',
      hook_strength: Math.min(100, score + (hasTension(text) ? 2 : 0)),
      retention_potential: Math.max(70, score - 2),
      story_completeness: Math.max(70, score - (hasPayoff(text) ? 0 : 5)),
      entertainment_or_emotion: Math.max(70, score - 6),
      educational_value: Math.max(70, score - (hasPayoff(text) ? 2 : 8)),
      speaker_energy: Math.max(70, score - 5),
      overall_score: score,
      standalone_confidence: Number(Math.min(0.95, Math.max(0.7, score / 100)).toFixed(2)),
      opening_line: openingLine(text),
      closing_line: closingLine(text),
      label: labelForText(text),
      editorial_exclusion_reason: editorialExclusionReason({ text, startSec: start, endSec: end, totalSeconds }),
    };
  });

  const seen = new Set<string>();
  const selectedWindows: Array<{ start: number; end: number }> = [];
  const candidates = rawCandidates
    .sort((a, b) => b.overall_score - a.overall_score)
    .filter((candidate) => {
      if (candidate.editorial_exclusion_reason) return false;
      const key = `${Math.round(candidate.adjusted_start / 8)}:${candidate.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      if (overlapsSelected(candidate.adjusted_start, candidate.adjusted_end, selectedWindows)) return false;
      seen.add(key);
      const keep = candidate.duration_seconds >= Math.min(policy.minSec, windowSeconds);
      if (keep) selectedWindows.push({ start: candidate.adjusted_start, end: candidate.adjusted_end });
      return keep;
    })
    .slice(0, Math.max(policy.candidateCount, targetCount * 4, policy.targetMin));

  return { candidates };
}
