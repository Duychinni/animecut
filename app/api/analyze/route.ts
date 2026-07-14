import { NextResponse } from 'next/server';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { analyzeClipCandidates } from '@/lib/openai';
import { getClipPolicy, getTargetClipCount } from '@/lib/clip-policy';
import { isLikelyMockTranscript, isMockClipAnalysisEnabled } from '@/lib/dev-ai';
import { generateHookText } from '@/lib/hook-text';
import { analyzeTranscriptLocally } from '@/lib/local-analysis';

export const maxDuration = 60;

type RawCandidate = Record<string, string | number | null | undefined>;

const GLOBAL_MAX_CLIP_SEC = 120;
const GLOBAL_MIN_CLIP_SEC = 30;
const EXPAND_SEC = 15;
const SELF_CONTAINED_MIN_CONFIDENCE = 0.55;
const MIN_TOP_CLIP_SCORE = 70;

type TranscriptSegment = {
  start?: number;
  end?: number;
  text?: string;
};

type RankedCandidate = {
  project_id: string;
  raw_start: number;
  raw_end: number;
  start_sec: number;
  end_sec: number;
  duration_seconds: number;
  title: string;
  hook_text: string;
  reason: string;
  self_contained_confidence: number;
  boundary_adjustment_reason: string;
  opening_line: string;
  closing_line: string;
  hook_strength: number;
  retention_potential: number;
  story_completeness: number;
  entertainment_or_emotion: number;
  educational_value: number;
  speaker_energy: number;
  overall_score: number;
  reject_reason: string | null;
  rank: number;
  passes_quality: boolean;
};

function num(v: string | number | null | undefined): number {
  return Number(v ?? 0);
}

function clamp100(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function calibrateFinalScores<T extends { overall_score: number; passes_quality?: boolean }>(items: T[]) {
  if (!items.length) return items;
  if (items.length === 1) {
    return items.map((item) => ({ ...item, overall_score: Math.max(78, Math.min(96, Math.round(item.overall_score))) }));
  }

  const spread = 24;
  return items.map((item, index) => {
    const rankRatio = index / Math.max(1, items.length - 1);
    const rankTarget = 97 - rankRatio * spread;
    const qualityPenalty = item.passes_quality === false ? 4 : 0;
    const raw = Number.isFinite(item.overall_score) ? item.overall_score : rankTarget;
    const blended = raw * 0.25 + rankTarget * 0.75 - qualityPenalty;
    return {
      ...item,
      overall_score: Math.max(70, Math.min(98, Math.round(blended))),
    };
  });
}

function normalizeWindow(startRaw: number, endRaw: number, minClipSec: number, maxClipSec: number) {
  const start = Math.max(0, Number.isFinite(startRaw) ? startRaw : 0);
  let end = Number.isFinite(endRaw) ? endRaw : start + minClipSec;

  if (end <= start) end = start + minClipSec;

  let duration = end - start;
  if (duration < minClipSec) {
    end = start + minClipSec;
    duration = minClipSec;
  }

  if (duration > maxClipSec) {
    end = start + maxClipSec;
    duration = maxClipSec;
  }

  return { start_sec: start, end_sec: end, duration_sec: duration };
}

function segStart(seg: TranscriptSegment): number {
  return Number.isFinite(seg.start) ? Number(seg.start) : 0;
}

function segEnd(seg: TranscriptSegment): number {
  const start = segStart(seg);
  const end = Number(seg.end);
  return Number.isFinite(end) && end > start ? end : start;
}

function textOf(seg: TranscriptSegment): string {
  return String(seg.text ?? '').trim();
}

function segmentOverlapsWindow(seg: TranscriptSegment, startSec: number, endSec: number): boolean {
  return segEnd(seg) > startSec && segStart(seg) < endSec;
}

function openingLineForWindow(startSec: number, endSec: number, segments: TranscriptSegment[]): string {
  const first = segments.find((s) => segmentOverlapsWindow(s, startSec, endSec));
  return first ? textOf(first) : '';
}

function closingLineForWindow(startSec: number, endSec: number, segments: TranscriptSegment[]): string {
  const inRange = segments.filter((s) => segmentOverlapsWindow(s, startSec, endSec));
  const last = inRange[inRange.length - 1];
  return last ? textOf(last) : '';
}

function startsLikeNaturalBoundary(text: string): boolean {
  if (!text) return false;
  const cleaned = text.replace(/^['"“”‘’\-–—\s]+/, '');
  if (!cleaned) return false;
  const weakOpen = /^(and|but|so|because|then)\b/i.test(cleaned);
  if (weakOpen) return false;
  return /^[A-Z0-9]/.test(cleaned) || /^(I|We|You|He|She|They|Now|Look|Here|Let me|The|This)\b/.test(cleaned);
}

function endsSentence(text: string): boolean {
  return /[.!?]["”’']?$/.test(text.trim());
}

function endsWithFiller(text: string): boolean {
  const t = text.toLowerCase().trim();
  return /(\b(uh|um|like|you know|i mean|kinda|sorta|basically|anyway|so)\b[,.! ]*)$/.test(t);
}

function isIncompleteTrailingPhrase(text: string): boolean {
  return /\b(and|but|because|so|if|when|while|where|that|which|who|to|for|with|about|from|into|of|or|as)\b[,\s]*$/i.test(text.trim());
}

function isCompleteStatementBoundary(segments: TranscriptSegment[], idx: number): boolean {
  const cur = segments[idx];
  const text = textOf(cur);
  if (!text || endsWithFiller(text) || isIncompleteTrailingPhrase(text)) return false;
  if (endsSentence(text)) return true;

  const next = segments[idx + 1];
  const pauseAfter = next ? segStart(next) - segEnd(cur) : 0;
  return pauseAfter >= 0.8 && countWords(text) >= 4;
}

function segmentIndexAtClipEnd(segments: TranscriptSegment[], endSec: number): number {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segStart(segments[i]) < endSec && segEnd(segments[i]) <= endSec + 0.05) return i;
  }
  return -1;
}

function snapEndToCompleteStatement(
  startSec: number,
  preferredEndSec: number,
  segments: TranscriptSegment[],
  minClipSec: number,
  maxClipSec: number,
) {
  const transcriptEnd = segments.reduce((acc, s) => Math.max(acc, segEnd(s)), 0);
  const minEnd = Math.min(transcriptEnd || startSec + minClipSec, startSec + minClipSec);
  const maxEnd = transcriptEnd > 0 ? Math.min(transcriptEnd, startSec + maxClipSec) : startSec + maxClipSec;
  const completeBoundaries = segments
    .map((seg, idx) => ({ idx, end: segEnd(seg) }))
    .filter((item) => item.end >= minEnd && item.end <= maxEnd && isCompleteStatementBoundary(segments, item.idx));

  if (!completeBoundaries.length) {
    const currentIdx = segmentIndexAtClipEnd(segments, preferredEndSec);
    return {
      end: preferredEndSec,
      idx: currentIdx,
      snapped: false,
      complete: currentIdx >= 0 ? isCompleteStatementBoundary(segments, currentIdx) : false,
    };
  }

  const nearbyAfter = completeBoundaries
    .filter((item) => item.end >= preferredEndSec - 0.1 && item.end <= preferredEndSec + 18)
    .sort((a, b) => a.end - b.end)[0];
  const nearest = completeBoundaries
    .slice()
    .sort((a, b) => Math.abs(a.end - preferredEndSec) - Math.abs(b.end - preferredEndSec))[0];
  const chosen = nearbyAfter ?? nearest;

  return {
    end: chosen.end,
    idx: chosen.idx,
    snapped: Math.abs(chosen.end - preferredEndSec) >= 0.3,
    complete: true,
  };
}

function clampDurationWithSegments(startSec: number, endSec: number, segments: TranscriptSegment[], minClipSec: number, maxClipSec: number) {
  let start = Math.max(0, startSec);
  let end = Math.max(start + 0.2, endSec);

  let duration = end - start;
  if (duration < minClipSec) {
    const needed = minClipSec - duration;
    end += needed;
  }

  duration = end - start;
  if (duration > maxClipSec) {
    end = start + maxClipSec;
  }

  const maxSegmentEnd = segments.reduce((acc, s) => Math.max(acc, segEnd(s)), 0);
  if (maxSegmentEnd > 0) {
    end = Math.min(end, maxSegmentEnd);
  }

  if (end - start < minClipSec) {
    start = Math.max(0, end - minClipSec);
  }

  return { start, end };
}

function countWords(text: string) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function countTranscriptWordsInRange(segments: TranscriptSegment[], startSec: number, endSec: number) {
  return segments
    .filter((seg) => segmentOverlapsWindow(seg, startSec, endSec))
    .reduce((total, seg) => total + countWords(textOf(seg)), 0);
}

function normalizeTitle(t: string) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function normalizeDisplayTitle(raw: unknown) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\-:\s]+/, '')
    .replace(/["']+$/g, '')
    .trim();
}

function titleCasePhrase(text: string) {
  return normalizeDisplayTitle(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function looksLikeTranscriptTitle(title: string, openingLine: string) {
  const normalizedTitle = normalizeTitle(title);
  const normalizedOpening = normalizeTitle(openingLine);
  if (!normalizedTitle) return true;
  if (normalizedTitle.split(/\s+/).length > 12) return true;
  if (/^(and|but|so|yeah|well|like|you know|i mean)\b/i.test(title.trim())) return true;
  if (normalizedOpening && normalizedOpening.startsWith(normalizedTitle)) return true;
  if (normalizedTitle.length > 14 && normalizedOpening.includes(normalizedTitle)) return true;
  return false;
}

function keywordDisplayTitle(openingLine: string, closingLine: string, reason: unknown, index: number) {
  const source = normalizeDisplayTitle(`${openingLine} ${closingLine} ${String(reason ?? '')}`);
  if (/\b(flat earth|earth|planet|moon|space|gravity)\b/i.test(source)) return 'The Evidence Behind the Flat Earth Debate';
  if (/\b(fight|ufc|boxing|knockout|rematch|fighter|opponent|challenge)\b/i.test(source)) {
    if (/\b(bet|money|odds|wager)\b/i.test(source)) return 'The Fight Bet They Could Not Agree On';
    if (/\b(knockout|knock out|ko)\b/i.test(source)) return 'The Knockout Claim Behind the Debate';
    if (/\b(duck|soft|scared|afraid|avoid)\b/i.test(source)) return 'The Accusation Dividing the Fight Debate';
    return 'The Fight Prediction They Disagree On';
  }
  if (/\b(song|music|producer|album|record|studio)\b/i.test(source)) return 'The Decision That Changed the Music Story';
  if (/\b(podcast|interview|question|answer)\b/i.test(source)) return 'The Question That Changed the Conversation';
  if (/\b(truth|secret|mistake|problem|wrong|realized)\b/i.test(source)) return 'The Realization That Changed Their View';
  if (/\b(funny|laugh|joke|hilarious)\b/i.test(source)) return 'The Joke That Broke the Conversation';
  if (/\b(emotional|daughter|family|memory|lost|honest)\b/i.test(source)) return 'The Personal Story Behind the Reaction';

  const words = source
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

function buildDisplayTitle(rawTitle: unknown, openingLine: string, closingLine: string, reason: unknown, index: number) {
  const title = normalizeDisplayTitle(rawTitle);
  if (title && !looksLikeTranscriptTitle(title, openingLine)) {
    return title.length > 82 ? `${title.slice(0, 79).trim()}...` : title;
  }
  return keywordDisplayTitle(openingLine, closingLine, reason, index);
}

function normalizeLooseText(t: string) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(and|but|so|yeah|well|like|you know|i mean)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNearDuplicateWindow(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const minDur = Math.max(1, Math.min(aEnd - aStart, bEnd - bStart));
  const startDelta = Math.abs(aStart - bStart);
  const endDelta = Math.abs(aEnd - bEnd);
  const overlapRatio = overlap / minDur;
  return (startDelta < 3 && endDelta < 3) || overlapRatio >= 0.8;
}

const STORY_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before', 'being', 'but', 'could', 'does',
  'from', 'have', 'here', 'into', 'just', 'like', 'more', 'only', 'really', 'said', 'that', 'their', 'there',
  'they', 'this', 'those', 'through', 'what', 'when', 'where', 'which', 'with', 'would', 'your',
]);

function storyTokens(candidate: RankedCandidate) {
  return new Set(normalizeLooseText([
    candidate.title,
    candidate.hook_text,
    candidate.opening_line,
    candidate.closing_line,
  ].join(' '))
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STORY_STOPWORDS.has(word)));
}

function storySimilarity(a: RankedCandidate, b: RankedCandidate) {
  const aTokens = storyTokens(a);
  const bTokens = storyTokens(b);
  if (!aTokens.size || !bTokens.size) return 0;
  let shared = 0;
  for (const token of aTokens) if (bTokens.has(token)) shared += 1;
  return shared / Math.max(1, new Set([...aTokens, ...bTokens]).size);
}

function candidateOverlapRatio(a: RankedCandidate, b: RankedCandidate) {
  const overlap = Math.max(0, Math.min(a.end_sec, b.end_sec) - Math.max(a.start_sec, b.start_sec));
  return overlap / Math.max(1, Math.min(a.end_sec - a.start_sec, b.end_sec - b.start_sec));
}

function isGenericEditorialTitle(title: string) {
  return /^(fight talk|interview|standout clip|top moment|viral moment|best moment|the truth behind|a conversation worth hearing)/i.test(title.trim());
}

function hasReliableSentencePunctuation(segments: TranscriptSegment[]) {
  const sampled = segments
    .map((segment) => textOf(segment))
    .filter((text) => countWords(text) >= 3)
    .slice(0, 320);

  if (sampled.length < 8) return true;
  const punctuated = sampled.filter((text) => endsSentence(text)).length;
  return punctuated / sampled.length >= 0.16;
}

function strictWordFloor(totalSeconds: number) {
  if (totalSeconds < 60) return 30;
  if (totalSeconds <= 10 * 60) return 42;
  if (totalSeconds <= 20 * 60) return 46;
  return 55;
}

function fallbackWordFloor(totalSeconds: number) {
  if (totalSeconds < 60) return 22;
  if (totalSeconds <= 10 * 60) return 32;
  if (totalSeconds <= 20 * 60) return 36;
  return 42;
}

function isDuplicateCandidate(cur: RankedCandidate, picked: RankedCandidate) {
  const curTitle = normalizeTitle(String(cur.title ?? ''));
  const pickedTitle = normalizeTitle(String(picked.title ?? ''));
  const similarity = storySimilarity(cur, picked);
  const overlapRatio = candidateOverlapRatio(cur, picked);
  const sameTitle = curTitle.length > 10
    && pickedTitle.length > 10
    && curTitle === pickedTitle
    && !isGenericEditorialTitle(curTitle)
    && similarity >= 0.45;
  const sameStory = similarity >= 0.82 || (similarity >= 0.58 && overlapRatio > 0.2);
  const sameWindow = isNearDuplicateWindow(
    Number(cur.start_sec ?? 0),
    Number(cur.end_sec ?? 0),
    Number(picked.start_sec ?? 0),
    Number(picked.end_sec ?? 0),
  );

  return sameTitle || sameStory || sameWindow;
}

function distinctCandidates(candidates: RankedCandidate[]) {
  return [...candidates]
    .sort((a, b) => Number(b.overall_score ?? 0) - Number(a.overall_score ?? 0))
    .reduce<RankedCandidate[]>((acc, cur) => {
      if (!acc.some((picked) => isDuplicateCandidate(cur, picked))) {
        acc.push(cur);
      }
      return acc;
    }, []);
}

function isCoverageDuplicate(cur: RankedCandidate, picked: RankedCandidate) {
  const curStart = Number(cur.start_sec ?? 0);
  const curEnd = Number(cur.end_sec ?? 0);
  const pickedStart = Number(picked.start_sec ?? 0);
  const pickedEnd = Number(picked.end_sec ?? 0);
  const overlap = Math.max(0, Math.min(curEnd, pickedEnd) - Math.max(curStart, pickedStart));
  const minDuration = Math.max(1, Math.min(curEnd - curStart, pickedEnd - pickedStart));
  const curCenter = (curStart + curEnd) / 2;
  const pickedCenter = (pickedStart + pickedEnd) / 2;
  const exactWindow = Math.abs(curStart - pickedStart) < 3 && Math.abs(curEnd - pickedEnd) < 3;
  const nearSameMoment = Math.abs(curCenter - pickedCenter) < 10 && overlap / minDuration >= 0.62;
  const nearlyContained = overlap / minDuration >= 0.82;
  return exactWindow || nearSameMoment || nearlyContained;
}

function coverageBucket(startSec: number, totalSeconds: number, desiredCount: number) {
  const bucketSize = Math.max(1, totalSeconds / Math.max(1, desiredCount));
  return Math.max(0, Math.min(desiredCount - 1, Math.floor(startSec / bucketSize)));
}

function buildTranscriptCoverageCandidates(params: {
  projectId: string;
  segments: TranscriptSegment[];
  totalSeconds: number;
  desiredCount: number;
  minClipSec: number;
  expectedMinSec: number;
  expectedMaxSec: number;
  maxClipSec: number;
  minimumWords: number;
}) {
  const candidates: RankedCandidate[] = [];
  const bucketSize = params.totalSeconds / Math.max(1, params.desiredCount);
  const targetDuration = Math.max(
    params.expectedMinSec,
    Math.min(params.expectedMaxSec, Math.min(48, bucketSize * 0.72)),
  );

  // Two offsets per time bucket make this independent from the AI/local pool.
  // It is only used when normal quality ranking under-produces the policy floor.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let bucket = 0; bucket < params.desiredCount; bucket += 1) {
      const bucketStart = bucket * bucketSize;
      const offset = pass === 0 ? bucketSize * 0.08 : bucketSize * 0.34;
      const rawStart = Math.max(0, Math.min(params.totalSeconds - targetDuration, bucketStart + offset));
      const rawEnd = Math.min(params.totalSeconds, rawStart + targetDuration);
      const cleaned = adjustBoundaries(
        rawStart,
        rawEnd,
        params.segments,
        Math.max(15, Math.min(params.minClipSec, targetDuration)),
        params.maxClipSec,
      );
      const transcriptWordCount = countTranscriptWordsInRange(params.segments, cleaned.start_sec, cleaned.end_sec);
      if (transcriptWordCount < Math.max(18, params.minimumWords - 10)) continue;

      const openingLine = openingLineForWindow(cleaned.start_sec, cleaned.end_sec, params.segments);
      const closingLine = closingLineForWindow(cleaned.start_sec, cleaned.end_sec, params.segments);
      if (!openingLine || !closingLine || endsWithFiller(closingLine) || isIncompleteTrailingPhrase(closingLine)) continue;

      const index = pass * params.desiredCount + bucket;
      const title = keywordDisplayTitle(openingLine, closingLine, 'Transcript coverage moment', index);
      const passesQuality = startsLikeNaturalBoundary(openingLine) && cleaned.end_complete;
      const overallScore = passesQuality ? 76 : 71;
      candidates.push({
        project_id: params.projectId,
        raw_start: rawStart,
        raw_end: rawEnd,
        start_sec: cleaned.start_sec,
        end_sec: cleaned.end_sec,
        duration_seconds: Number((cleaned.end_sec - cleaned.start_sec).toFixed(2)),
        title,
        hook_text: resolveCandidateHookText({
          rawHookText: null,
          title,
          openingLine,
          segments: params.segments,
          startSec: cleaned.start_sec,
          endSec: cleaned.end_sec,
        }),
        reason: `Independent transcript coverage fallback for bucket ${bucket + 1}/${params.desiredCount}. Boundary pass: ${cleaned.reason}`,
        self_contained_confidence: passesQuality ? 0.72 : 0.62,
        boundary_adjustment_reason: cleaned.reason,
        opening_line: openingLine,
        closing_line: closingLine,
        hook_strength: overallScore,
        retention_potential: overallScore,
        story_completeness: passesQuality ? 78 : 70,
        entertainment_or_emotion: 70,
        educational_value: 70,
        speaker_energy: 72,
        overall_score: overallScore,
        reject_reason: null,
        rank: index + 1,
        passes_quality: passesQuality,
      });
    }
  }

  return candidates;
}

function hasStrongPayoff(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (!endsSentence(t)) return false;
  return /(!|\?|\.|\bthat'?s why\b|\bthe point is\b|\bso the answer is\b|\bwhich means\b|\bthat means\b|\bthe result is\b|\bthe lesson is\b)/i.test(t);
}

function normalizeHookText(raw: unknown, fallback: string) {
  const cleaned = String(raw ?? fallback ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\-:\s]+/, '')
    .replace(/["']+$/g, '')
    .replace(/[.,;:\s]+$/g, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const kept: string[] = [];

  for (const word of words) {
    const next = [...kept, word].join(' ');
    if (kept.length >= 8 || next.length > 38) break;
    kept.push(word);
  }

  const text = kept.join(' ');
  return text || 'Top Moment';
}

function normalizeOptionalHookText(raw: unknown) {
  if (!String(raw ?? '').trim()) return null;
  return normalizeHookText(raw, '');
}

function isGenericHookText(text: string) {
  return /^(top moment|viral moment|best moment|clip|short|reel)$/i.test(text.trim());
}

function isTitleLikeHook(hookText: string, title: string) {
  const hookLoose = normalizeLooseText(hookText);
  const titleLoose = normalizeLooseText(title);
  if (!hookLoose || !titleLoose) return false;
  if (hookLoose === titleLoose) return true;
  if (hookLoose.length >= 10 && titleLoose.includes(hookLoose)) return true;
  if (titleLoose.length >= 10 && hookLoose.includes(titleLoose)) return true;

  const hookWords = hookLoose.split(/\s+/).filter((word) => word.length > 2);
  const titleWords = new Set(titleLoose.split(/\s+/).filter((word) => word.length > 2));
  if (!hookWords.length || !titleWords.size) return false;
  const overlap = hookWords.filter((word) => titleWords.has(word)).length / hookWords.length;
  return hookWords.length >= 3 && overlap >= 0.8;
}

function resolveCandidateHookText(params: {
  rawHookText: unknown;
  title: unknown;
  openingLine: string;
  segments: TranscriptSegment[];
  startSec: number;
  endSec: number;
}) {
  const rawHook = normalizeOptionalHookText(params.rawHookText);
  const title = String(params.title ?? '');

  if (rawHook) {
    if (!isTitleLikeHook(rawHook, title) && !isGenericHookText(rawHook)) return rawHook;
  }

  const transcriptHook = normalizeOptionalHookText(generateHookText({
    clipTitle: title,
    transcriptSegments: params.segments,
    startSec: params.startSec,
    endSec: params.endSec,
  }));

  if (transcriptHook && !isGenericHookText(transcriptHook) && !isTitleLikeHook(transcriptHook, title)) {
    return transcriptHook;
  }

  const openingHook = normalizeHookText(params.openingLine, '');
  if (!isGenericHookText(openingHook) && !isTitleLikeHook(openingHook, title)) return openingHook;

  return 'This Is The Part That Matters';
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return [
      record.message,
      record.details,
      record.hint,
      record.code,
      JSON.stringify(record),
    ]
      .filter(Boolean)
      .join(' ');
  }
  return String(error);
}

function isMissingHookTextColumnError(error: unknown) {
  const text = errorText(error);
  return /hook_text/i.test(text) && /(column|schema cache|could not find|PGRST204|42703)/i.test(text);
}

function isLocalAnalysisCandidate(candidate: RawCandidate) {
  return String(candidate.analysis_provider ?? '').toLowerCase() === 'local'
    || String(candidate.reason_selected ?? candidate.reason ?? '').toLowerCase().includes('local analysis');
}

function expandWindowAroundMoment(startSec: number, endSec: number, segments: TranscriptSegment[], contextLeadSec: number, payoffTailSec: number) {
  const start = Math.max(0, startSec - contextLeadSec);
  const end = endSec + payoffTailSec;
  return { start, end };
}

function adjustBoundaries(
  startRaw: number,
  endRaw: number,
  segments: TranscriptSegment[],
  minClipSec: number,
  maxClipSec: number,
): {
  start_sec: number;
  end_sec: number;
  reason: string;
  confidence: number;
  end_complete: boolean;
} {
  const base = normalizeWindow(startRaw, endRaw, minClipSec, maxClipSec);
  if (!segments.length) {
    return {
      start_sec: base.start_sec,
      end_sec: base.end_sec,
      reason: 'No transcript segments available for second-pass boundary cleaning; kept normalized window.',
      confidence: 0.45,
      end_complete: false,
    };
  }

  const smartExpansion = expandWindowAroundMoment(base.start_sec, base.end_sec, segments, 8, 15);
  const expandedStart = Math.max(0, smartExpansion.start - EXPAND_SEC);
  const expandedEnd = smartExpansion.end + EXPAND_SEC;

  const inRange = segments
    .map((seg, idx) => ({ seg, idx, start: segStart(seg), end: segEnd(seg), text: textOf(seg) }))
    .filter((s) => s.end >= expandedStart && s.start <= expandedEnd);

  if (!inRange.length) {
    return {
      start_sec: base.start_sec,
      end_sec: base.end_sec,
      reason: 'No aligned transcript chunks in expanded window; kept normalized window.',
      confidence: 0.5,
      end_complete: false,
    };
  }

  const firstIdx = inRange[0].idx;
  const lastIdx = inRange[inRange.length - 1].idx;

  let startIdx = inRange.find((s) => s.start >= base.start_sec)?.idx ?? firstIdx;
  for (let i = startIdx; i >= firstIdx; i -= 1) {
    const cur = segments[i];
    const curText = textOf(cur);
    const prevText = i > 0 ? textOf(segments[i - 1]) : '';
    const goodOpen = startsLikeNaturalBoundary(curText);
    const prevCloses = i === 0 || endsSentence(prevText);
    const notMidSentence = !/^[a-z]/.test(curText);
    if ((goodOpen && prevCloses) || (prevCloses && notMidSentence)) {
      startIdx = i;
      break;
    }
  }

  let endIdx = inRange.slice().reverse().find((s) => s.end <= base.end_sec)?.idx ?? lastIdx;
  for (let i = endIdx; i <= lastIdx; i += 1) {
    const curText = textOf(segments[i]);
    const sentenceDone = endsSentence(curText);
    const fillerTail = endsWithFiller(curText);
    const payoffStrong = hasStrongPayoff(curText);
    if ((sentenceDone && !fillerTail && payoffStrong) || (sentenceDone && !fillerTail && i >= endIdx + 1)) {
      endIdx = i;
      break;
    }
    if (i > endIdx + 4) break;
  }

  const adjustedStart = segStart(segments[startIdx]);
  const adjustedEnd = segEnd(segments[endIdx]);
  const clamped = clampDurationWithSegments(adjustedStart, adjustedEnd, segments, minClipSec, maxClipSec);
  const snappedEnd = snapEndToCompleteStatement(clamped.start, clamped.end, segments, minClipSec, maxClipSec);

  const startMoved = Math.abs(clamped.start - base.start_sec) >= 0.3;
  const endMoved = Math.abs(snappedEnd.end - base.end_sec) >= 0.3;
  const finalEndIdx = snappedEnd.idx >= 0 ? snappedEnd.idx : segmentIndexAtClipEnd(segments, snappedEnd.end);
  const endText = finalEndIdx >= 0 ? textOf(segments[finalEndIdx]) : closingLineForWindow(clamped.start, snappedEnd.end, segments);
  const startText = textOf(segments[startIdx]);

  let confidence = 0.62;
  if (startsLikeNaturalBoundary(startText)) confidence += 0.14;
  if (snappedEnd.complete) confidence += 0.14;
  if (!endsWithFiller(endText)) confidence += 0.08;
  if (snappedEnd.end - clamped.start >= minClipSec && snappedEnd.end - clamped.start <= Math.min(maxClipSec, 60)) confidence += 0.08;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  const reasons = [] as string[];
  if (startMoved) reasons.push('shifted start to nearest natural sentence/thought boundary');
  if (endMoved) reasons.push('extended/trimmed end to complete the speaker payoff');
  if (snappedEnd.snapped) reasons.push('snapped export end to a complete statement boundary');
  if (endsWithFiller(endText)) reasons.push('detected filler-style tail (lower self-contained confidence)');
  if (!snappedEnd.complete) reasons.push('could not confirm a complete statement ending');
  if (!reasons.length) reasons.push('raw timestamps already aligned with natural boundaries');

  return {
    start_sec: clamped.start,
    end_sec: snappedEnd.end,
    reason: reasons.join('; '),
    confidence,
    end_complete: snappedEnd.complete,
  };
}

async function runProjectAnalysis(project_id: string, options: { forceLocal?: boolean } = {}) {
    const supabase = createAdminClient();

    const { data: transcriptRow, error: tErr } = await supabase
      .from('transcripts')
      .select('full_text, segments_json')
      .eq('project_id', project_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (tErr) throw tErr;

    const segments =
      ((transcriptRow.segments_json as TranscriptSegment[] | null) ?? []).filter(
        (s) => typeof s === 'object' && s !== null,
      );

    if (!isMockClipAnalysisEnabled() && isLikelyMockTranscript(segments)) {
      throw new Error('This project still has a mock transcript. Start a new test after turning MOCK_AI/MOCK_TRANSCRIPTION/MOCK_ANALYSIS off so captions can use real faster-whisper words.');
    }

    const transcriptMaxEnd = segments.reduce((acc, s) => Math.max(acc, segEnd(s)), 0);
    const effectiveGlobalMinClipSec = transcriptMaxEnd < 60 ? 20 : GLOBAL_MIN_CLIP_SEC;
    const policy = getClipPolicy(transcriptMaxEnd);
    const analysisMinClipSec = Math.max(policy.minSec, Math.min(effectiveGlobalMinClipSec, policy.expectedMinSec));
    const minimumWordCount = strictWordFloor(transcriptMaxEnd);
    const fallbackMinimumWordCount = fallbackWordFloor(transcriptMaxEnd);
    const punctuationReliable = hasReliableSentencePunctuation(segments);
    const targetClipCount = getTargetClipCount(transcriptMaxEnd);
    const minimumCandidatePool = Math.max(policy.candidateCount, targetClipCount * 4);
    const candidateLimit = Math.max(minimumCandidatePool, targetClipCount * 4);

    const parsed = options.forceLocal
      ? analyzeTranscriptLocally(transcriptRow.full_text as string, segments)
      : await analyzeClipCandidates(transcriptRow.full_text as string, segments);
    const analysisDiagnostics = options.forceLocal
      ? { provider: 'local', openai_timed_out: false, fallback_used: true, fallback_reason: 'force_local_requested' }
      : ((parsed as { diagnostics?: Record<string, unknown> }).diagnostics ?? {
          provider: 'unknown', openai_timed_out: false, fallback_used: false, fallback_reason: null,
        });
    const aiReturnedCount = Array.isArray(parsed.candidates) ? parsed.candidates.length : 0;
    const localSupplement = options.forceLocal
      ? { candidates: [] }
      : analyzeTranscriptLocally(transcriptRow.full_text as string, segments);
    const analysisCandidates = [
      ...(parsed.candidates ?? []).slice(0, candidateLimit),
      ...(localSupplement.candidates ?? []).slice(0, candidateLimit),
    ];

    const allScoredCandidates: RankedCandidate[] = analysisCandidates
      .map((c: RawCandidate, idx: number) => {
        const localAnalysisCandidate = isLocalAnalysisCandidate(c);
        const rawStart = num(c.raw_start ?? c.start_sec ?? c.adjusted_start);
        const rawEnd = num(c.raw_end ?? c.end_sec ?? c.adjusted_end);
        const modelAdjustedStart = num(c.adjusted_start ?? rawStart);
        const modelAdjustedEnd = num(c.adjusted_end ?? rawEnd);
        const cleaned = adjustBoundaries(modelAdjustedStart, modelAdjustedEnd, segments, analysisMinClipSec, Math.min(policy.maxSec, GLOBAL_MAX_CLIP_SEC));

        const openingLine = openingLineForWindow(cleaned.start_sec, cleaned.end_sec, segments) || String(c.opening_line ?? '');
        const closingLine = closingLineForWindow(cleaned.start_sec, cleaned.end_sec, segments) || String(c.closing_line ?? '');
        const displayTitle = buildDisplayTitle(c.title, openingLine, closingLine, c.reason_selected ?? c.reason, idx);
        const transcriptWordCount = countTranscriptWordsInRange(segments, cleaned.start_sec, cleaned.end_sec);
        const payoffStrong = hasStrongPayoff(closingLine);
        const cleanEnding = !endsWithFiller(closingLine) && !isIncompleteTrailingPhrase(closingLine);
        const completeEnding = cleanEnding && (cleaned.end_complete || !punctuationReliable || localAnalysisCandidate);
        const strictQualityPass = startsLikeNaturalBoundary(openingLine) && completeEnding && (payoffStrong || !punctuationReliable);
        const passesQuality = localAnalysisCandidate
          ? Boolean(startsLikeNaturalBoundary(openingLine) && completeEnding && transcriptWordCount >= Math.min(minimumWordCount, 35))
          : strictQualityPass;

        const hookStrength = clamp100(num(c.hook_strength) || 0);
        const retentionPotential = clamp100(num(c.retention_potential ?? c.rewatch_potential) || 0);
        const storyCompleteness = clamp100(num(c.story_completeness ?? c.payoff_strength) || ((hasStrongPayoff(closingLine) && !endsWithFiller(closingLine)) ? 88 : 50));
        const entertainmentOrEmotion = clamp100(num(c.entertainment_or_emotion ?? c.emotional_or_engagement_value ?? c.emotional_intensity) || 0);
        const educationalValue = clamp100(num(c.educational_value) || 0);
        const speakerEnergy = clamp100(num(c.speaker_energy) || 0);

        const weightedOverall = clamp100(
          hookStrength * 0.25 +
          retentionPotential * 0.20 +
          storyCompleteness * 0.20 +
          entertainmentOrEmotion * 0.15 +
          educationalValue * 0.10 +
          speakerEnergy * 0.10
        );

        const qualityPenalty = passesQuality ? 0 : (localAnalysisCandidate ? 6 : 22);
        const duration = cleaned.end_sec - cleaned.start_sec;
        const durationPenalty =
          duration < policy.minSec ? 24 :
          duration < policy.expectedMinSec ? 10 :
          duration > policy.expectedMaxSec && duration <= policy.maxSec ? 6 :
          duration > policy.maxSec ? 12 :
          0;
        const confidenceBoost = cleaned.confidence >= 0.9 ? 2 : cleaned.confidence >= 0.8 ? 1 : 0;
        const baseOverall = num(c.overall_score) || weightedOverall;
        const calibratedOverall = localAnalysisCandidate
          ? Math.max(70, Math.round(baseOverall - qualityPenalty - Math.round(durationPenalty * 0.35)))
          : Math.round((baseOverall * 0.94) - 4 + confidenceBoost - qualityPenalty - durationPenalty);

        return {
          project_id,
          raw_start: rawStart,
          raw_end: rawEnd,
          start_sec: cleaned.start_sec,
          end_sec: cleaned.end_sec,
          duration_seconds: Number(duration.toFixed(2)),
          title: displayTitle,
          hook_text: resolveCandidateHookText({
            rawHookText: c.hook_text,
            title: displayTitle,
            openingLine,
            segments,
            startSec: cleaned.start_sec,
            endSec: cleaned.end_sec,
          }),
          reason: `${String(c.reason_selected ?? c.reason ?? 'High potential short-form segment')} | Boundary pass: ${cleaned.reason} | Self-contained confidence: ${cleaned.confidence.toFixed(2)} | Opening: ${openingLine} | Closing: ${closingLine}`,
          self_contained_confidence: Math.max(0, Math.min(1, num(c.standalone_confidence) || cleaned.confidence)),
          boundary_adjustment_reason: cleaned.reason,
          opening_line: openingLine,
          closing_line: closingLine,
          hook_strength: hookStrength,
          retention_potential: retentionPotential,
          story_completeness: storyCompleteness,
          entertainment_or_emotion: entertainmentOrEmotion,
          educational_value: educationalValue,
          speaker_energy: speakerEnergy,
          overall_score: clamp100(calibratedOverall),
          reject_reason: duration < analysisMinClipSec
              ? 'duration_below_minimum'
              : transcriptWordCount < minimumWordCount
                ? 'word_count_below_minimum'
                : !completeEnding
                  ? 'incomplete_sentence_ending'
                : calibratedOverall < MIN_TOP_CLIP_SCORE
                  ? 'score_below_minimum'
                  : !passesQuality
                    ? 'failed_quality_checks'
                  : null,
          rank: idx + 1,
          passes_quality: passesQuality,
        };
      });

    const scoredCandidates = allScoredCandidates
      .filter((c: RankedCandidate) => c.self_contained_confidence >= SELF_CONTAINED_MIN_CONFIDENCE)
      .filter((c: RankedCandidate) => c.duration_seconds >= analysisMinClipSec)
      .filter((c: RankedCandidate) => countTranscriptWordsInRange(segments, c.start_sec, c.end_sec) >= minimumWordCount)
      .filter((c: RankedCandidate) => c.reject_reason !== 'incomplete_sentence_ending')
      .filter((c: RankedCandidate) => Number(c.overall_score ?? 0) >= MIN_TOP_CLIP_SCORE);

    const filteredCandidates = scoredCandidates;

    const deduped = distinctCandidates(filteredCandidates);
    const selected = deduped.slice(0, targetClipCount);
    const minimumFinalCount = Math.min(policy.targetMin, targetClipCount);

    if (selected.length < minimumFinalCount) {
      const fallbackPool = distinctCandidates(allScoredCandidates)
        .filter((c) => !selected.some((picked) => isDuplicateCandidate(c, picked)))
        .filter((c) => c.duration_seconds >= analysisMinClipSec)
        .filter((c) => c.self_contained_confidence >= Math.max(0.42, SELF_CONTAINED_MIN_CONFIDENCE - 0.1))
        .filter((c) => countTranscriptWordsInRange(segments, c.start_sec, c.end_sec) >= fallbackMinimumWordCount)
        .filter((c) => Number(c.overall_score ?? 0) >= MIN_TOP_CLIP_SCORE - 10)
        .filter((c) => !endsWithFiller(c.closing_line) && !isIncompleteTrailingPhrase(c.closing_line));

      for (const candidate of fallbackPool) {
        if (selected.length >= minimumFinalCount) break;
        if (!selected.some((picked) => isDuplicateCandidate(candidate, picked))) {
          selected.push({
            ...candidate,
            reason: `${candidate.reason} | Added by fallback pass to reach the expected clip range for this source length.`,
          });
        }
      }
    }

    if (selected.length < minimumFinalCount) {
      // The quality pass deliberately removes overlapping ideas, but it must not
      // collapse a long source to one or two reels. This final pass uses a much
      // narrower duplicate definition and fills uncovered time buckets first.
      const occupiedBuckets = new Set(selected.map((candidate) => coverageBucket(candidate.start_sec, transcriptMaxEnd, minimumFinalCount)));
      const coveragePool = [...allScoredCandidates]
        .filter((c) => !selected.some((picked) => isCoverageDuplicate(c, picked)))
        .filter((c) => c.duration_seconds >= Math.max(15, analysisMinClipSec - 5))
        .filter((c) => countTranscriptWordsInRange(segments, c.start_sec, c.end_sec) >= Math.max(24, fallbackMinimumWordCount - 8))
        .filter((c) => Number(c.overall_score ?? 0) >= Math.max(55, MIN_TOP_CLIP_SCORE - 18))
        .sort((a, b) => {
          const aBucketOpen = occupiedBuckets.has(coverageBucket(a.start_sec, transcriptMaxEnd, minimumFinalCount)) ? 1 : 0;
          const bBucketOpen = occupiedBuckets.has(coverageBucket(b.start_sec, transcriptMaxEnd, minimumFinalCount)) ? 1 : 0;
          return aBucketOpen - bBucketOpen || Number(b.overall_score ?? 0) - Number(a.overall_score ?? 0);
        });

      for (const candidate of coveragePool) {
        if (selected.length >= minimumFinalCount) break;
        const bucket = coverageBucket(candidate.start_sec, transcriptMaxEnd, minimumFinalCount);
        if (occupiedBuckets.has(bucket)) continue;
        if (selected.some((picked) => isCoverageDuplicate(candidate, picked))) continue;
        selected.push({
          ...candidate,
          reason: `${candidate.reason} | Added by transcript coverage pass to avoid under-producing reels for this source length.`,
        });
        occupiedBuckets.add(bucket);
      }

      // If a quiet section has no viable standalone moment, fill from the best
      // remaining transcript regions instead of returning below the policy floor.
      for (const candidate of coveragePool) {
        if (selected.length >= minimumFinalCount) break;
        if (selected.some((picked) => isCoverageDuplicate(candidate, picked))) continue;
        selected.push({
          ...candidate,
          reason: `${candidate.reason} | Added by final quality backfill to meet the expected reel count for this source length.`,
        });
      }
    }

    if (selected.length < minimumFinalCount) {
      const independentCoveragePool = buildTranscriptCoverageCandidates({
        projectId: project_id,
        segments,
        totalSeconds: transcriptMaxEnd,
        desiredCount: minimumFinalCount,
        minClipSec: policy.minSec,
        expectedMinSec: policy.expectedMinSec,
        expectedMaxSec: policy.expectedMaxSec,
        maxClipSec: Math.min(policy.maxSec, GLOBAL_MAX_CLIP_SEC),
        minimumWords: fallbackMinimumWordCount,
      });

      for (const candidate of independentCoveragePool) {
        if (selected.length >= minimumFinalCount) break;
        if (selected.some((picked) => isCoverageDuplicate(candidate, picked))) continue;
        selected.push(candidate);
      }
    }

    const ranked = calibrateFinalScores(selected.slice(0, targetClipCount)).map((item, idx) => ({ ...item, rank: idx + 1 }));

    const sameCandidate = (left: RankedCandidate, right: RankedCandidate) => (
      Math.abs(left.start_sec - right.start_sec) < 0.05
      && Math.abs(left.end_sec - right.end_sec) < 0.05
      && normalizeTitle(left.title) === normalizeTitle(right.title)
    );
    const rejectedCandidateReport = allScoredCandidates
      .filter((candidate) => !ranked.some((selectedCandidate) => sameCandidate(candidate, selectedCandidate)))
      .map((candidate) => {
        let rejectionReason = candidate.reject_reason;
        if (!rejectionReason && candidate.self_contained_confidence < SELF_CONTAINED_MIN_CONFIDENCE) rejectionReason = 'self_contained_confidence_below_minimum';
        if (!rejectionReason && candidate.duration_seconds < analysisMinClipSec) rejectionReason = 'duration_below_minimum';
        if (!rejectionReason && countTranscriptWordsInRange(segments, candidate.start_sec, candidate.end_sec) < minimumWordCount) rejectionReason = 'word_count_below_minimum';
        if (!rejectionReason && ranked.some((selectedCandidate) => isDuplicateCandidate(candidate, selectedCandidate))) rejectionReason = 'semantic_or_timeline_duplicate';
        if (!rejectionReason) rejectionReason = 'ranked_below_final_selection_cutoff';
        return {
          start: candidate.start_sec,
          end: candidate.end_sec,
          duration: candidate.duration_seconds,
          title: candidate.title,
          hook: candidate.hook_text,
          score: Number(candidate.overall_score ?? 0),
          reason: rejectionReason,
        };
      });

    const productionDiagnostics = {
      project_id,
      transcript_segments: segments.length,
      transcript_duration_seconds: Number(transcriptMaxEnd.toFixed(2)),
      analysis_provider: analysisDiagnostics.provider ?? 'unknown',
      openai_timed_out: analysisDiagnostics.openai_timed_out === true,
      fallback_analysis_used: analysisDiagnostics.fallback_used === true,
      fallback_reason: analysisDiagnostics.fallback_reason ?? null,
      candidates_returned_by_primary_analysis: aiReturnedCount,
      local_supplement_candidates: localSupplement.candidates.length,
      candidates_before_deduplication: filteredCandidates.length,
      candidates_after_deduplication: deduped.length,
      final_selected_clip_count: ranked.length,
      selected_clips: ranked.map((candidate) => ({
        start: candidate.start_sec,
        end: candidate.end_sec,
        duration: candidate.duration_seconds,
        title: candidate.title,
        hook: candidate.hook_text,
        score: Number(candidate.overall_score ?? 0),
      })),
      rejected_candidates: rejectedCandidateReport,
    };
    console.log('[analyze:production-diagnostics]', JSON.stringify(productionDiagnostics));
    try {
      const diagnosticsDir = path.resolve(
        /* turbopackIgnore: true */
        process.env.ANALYSIS_DIAGNOSTICS_DIR?.trim() || './tmp/analysis-diagnostics',
      );
      await mkdir(diagnosticsDir, { recursive: true });
      const diagnosticsPath = path.join(diagnosticsDir, `${project_id}.candidate-report.json`);
      await writeFile(diagnosticsPath, JSON.stringify(productionDiagnostics, null, 2), 'utf8');
      console.log('[analyze:diagnostic-report-saved]', { project_id, diagnosticsPath });
    } catch (diagnosticError) {
      console.warn('[analyze:diagnostic-report-unavailable]', {
        project_id,
        error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
      });
    }

    console.log('[analyze] counts', {
      project_id,
      videoDurationSeconds: Number(transcriptMaxEnd.toFixed(2)),
      targetClipCount: targetClipCount,
      targetMin: policy.targetMin,
      minimumCandidatePool,
      minimumWordCount,
      fallbackMinimumWordCount,
      punctuationReliable,
      analysisDiagnostics,
      candidateCountGenerated: aiReturnedCount,
      localSupplementCount: localSupplement.candidates.length,
      candidateCountAfterLengthFilter: filteredCandidates.length,
      candidateCountAfterOverlapRemoval: deduped.length,
      finalClipCount: ranked.length,
      finalClips: ranked.map((c) => ({
        start: c.start_sec,
        end: c.end_sec,
        duration: c.duration_seconds,
        score: Number(c.overall_score ?? 0),
        title: c.title,
        hookText: c.hook_text,
        reasonSelected: c.reason,
      })),
      rejectedCandidates: rejectedCandidateReport.length,
      rejectedReasons: rejectedCandidateReport,
    });

    const toLegacyTenPoint = (value: number) => Math.max(1, Math.min(10, Math.round(value / 10)));

    const dbRows = ranked.map((item) => ({
      project_id: item.project_id,
      start_sec: item.start_sec,
      end_sec: item.end_sec,
      title: item.title,
      hook_text: item.hook_text,
      reason: item.reason,
      hook_strength: toLegacyTenPoint(Number(item.hook_strength ?? 0)),
      emotional_intensity: toLegacyTenPoint(Number(item.entertainment_or_emotion ?? 0)),
      clarity_without_context: toLegacyTenPoint(Number(item.story_completeness ?? 0)),
      rewatch_potential: toLegacyTenPoint(Number(item.retention_potential ?? 0)),
      overall_score: Number((item.overall_score ?? 0) / 10),
      rank: item.rank,
    }));

    await supabase.from('exports').delete().eq('project_id', project_id).in('status', ['queued', 'processing']);
    await supabase.from('jobs').delete().eq('project_id', project_id).eq('type', 'export').in('status', ['queued', 'processing']);

    await supabase.from('clip_candidates').delete().eq('project_id', project_id);
    if (!ranked.length) {
      await supabase.from('projects').update({
        status: 'completed',
        pipeline_status: 'completed',
        pipeline_stage: 'completed',
        pipeline_stage_label: 'No valid clips found',
        pipeline_progress_percent: 100,
        pipeline_error: 'not_enough_content',
        pipeline_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', project_id);

      return { ok: true, count: 0, candidates: [], reason: 'not_enough_content', diagnostics: productionDiagnostics };
    }

    let { data: insertedRows, error: insErr } = await supabase.from('clip_candidates').insert(dbRows).select('id, start_sec, end_sec, title');
    if (insErr && isMissingHookTextColumnError(insErr)) {
      console.warn('[analyze] hook_text column missing; retrying clip candidate insert without hook_text');
      const legacyRows = dbRows.map(({ hook_text: _hookText, ...row }) => row);
      const retry = await supabase.from('clip_candidates').insert(legacyRows).select('id, start_sec, end_sec, title');
      insertedRows = retry.data;
      insErr = retry.error;
    }
    if (insErr) throw insErr;

    await supabase.from('projects').update({ status: 'analyzed', pipeline_error: null }).eq('id', project_id);
    return {
      ok: true,
      count: ranked.length,
      candidates: ranked,
      inserted_candidate_ids: insertedRows?.map((row) => row.id) ?? [],
      diagnostics: productionDiagnostics,
    };
}

export async function POST(req: Request) {
  try {
    const { project_id, force_local } = await req.json();
    if (!project_id) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

    const result = await runProjectAnalysis(String(project_id), { forceLocal: Boolean(force_local) });
    return NextResponse.json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Analyze failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
