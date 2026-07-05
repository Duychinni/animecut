import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { analyzeClipCandidates } from '@/lib/openai';
import { overallScore } from '@/lib/scoring';

type RawCandidate = Record<string, string | number | null | undefined>;

const MIN_CLIP_SEC = 15;
const MAX_CLIP_SEC = 60;
const IDEAL_MAX_SEC = 45;
const EXPAND_SEC = 12;
const SELF_CONTAINED_MIN_CONFIDENCE = 0.55;
const MIN_RETURN_CLIPS = 5;

function targetClipCountForDuration(totalSeconds: number) {
  const minutes = totalSeconds / 60;
  if (minutes <= 5) return 5;
  if (minutes <= 15) return 7;
  if (minutes <= 30) return 10;
  if (minutes <= 60) return 15;
  if (minutes <= 120) return 20;
  return 25;
}

function minCandidatePoolForDuration(totalSeconds: number) {
  const minutes = totalSeconds / 60;
  if (minutes < 5) return 20;
  if (minutes <= 15) return 40;
  if (minutes <= 30) return 60;
  if (minutes <= 60) return 80;
  return 100;
}

type TranscriptSegment = {
  start?: number;
  end?: number;
  text?: string;
};

function num(v: string | number | null | undefined): number {
  return Number(v ?? 0);
}

function clamp10(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(0, Math.min(10, value)).toFixed(2));
}

function normalizeWindow(startRaw: number, endRaw: number) {
  const start = Math.max(0, Number.isFinite(startRaw) ? startRaw : 0);
  let end = Number.isFinite(endRaw) ? endRaw : start + MIN_CLIP_SEC;

  if (end <= start) end = start + MIN_CLIP_SEC;

  let duration = end - start;
  if (duration < MIN_CLIP_SEC) {
    end = start + MIN_CLIP_SEC;
    duration = MIN_CLIP_SEC;
  }

  if (duration > MAX_CLIP_SEC) {
    end = start + MAX_CLIP_SEC;
    duration = MAX_CLIP_SEC;
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

function openingLineForWindow(startSec: number, endSec: number, segments: TranscriptSegment[]): string {
  const first = segments.find((s) => segEnd(s) >= startSec && segStart(s) <= endSec);
  return first ? textOf(first) : '';
}

function closingLineForWindow(startSec: number, endSec: number, segments: TranscriptSegment[]): string {
  const inRange = segments.filter((s) => segEnd(s) >= startSec && segStart(s) <= endSec);
  const last = inRange[inRange.length - 1];
  return last ? textOf(last) : '';
}

function passesStandaloneQualityChecks(startLine: string, endLine: string): boolean {
  if (!startLine || !endLine) return false;
  if (!startsLikeNaturalBoundary(startLine)) return false;
  if (endsWithFiller(endLine)) return false;
  if (!endsSentence(endLine)) return false;
  return true;
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

function clampDurationWithSegments(startSec: number, endSec: number, segments: TranscriptSegment[]) {
  let start = Math.max(0, startSec);
  let end = Math.max(start + 0.2, endSec);

  let duration = end - start;
  if (duration < MIN_CLIP_SEC) {
    const needed = MIN_CLIP_SEC - duration;
    end += needed;
  }

  duration = end - start;
  if (duration > MAX_CLIP_SEC) {
    end = start + MAX_CLIP_SEC;
  }

  const maxSegmentEnd = segments.reduce((acc, s) => Math.max(acc, segEnd(s)), 0);
  if (maxSegmentEnd > 0) {
    end = Math.min(end, maxSegmentEnd);
  }

  if (end - start < MIN_CLIP_SEC) {
    start = Math.max(0, end - MIN_CLIP_SEC);
  }

  return { start, end };
}

function normalizeTitle(t: string) {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNearDuplicateWindow(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const minDur = Math.max(1, Math.min(aEnd - aStart, bEnd - bStart));
  const startDelta = Math.abs(aStart - bStart);
  const endDelta = Math.abs(aEnd - bEnd);
  const sameHookWindow = startDelta < 4 && endDelta < 4;
  return sameHookWindow && overlap / minDur >= 0.82;
}

function adjustBoundaries(
  startRaw: number,
  endRaw: number,
  segments: TranscriptSegment[],
): {
  start_sec: number;
  end_sec: number;
  reason: string;
  confidence: number;
} {
  const base = normalizeWindow(startRaw, endRaw);
  if (!segments.length) {
    return {
      start_sec: base.start_sec,
      end_sec: base.end_sec,
      reason: 'No transcript segments available for second-pass boundary cleaning; kept normalized window.',
      confidence: 0.45,
    };
  }

  const expandedStart = Math.max(0, base.start_sec - EXPAND_SEC);
  const expandedEnd = base.end_sec + EXPAND_SEC;

  const inRange = segments
    .map((seg, idx) => ({ seg, idx, start: segStart(seg), end: segEnd(seg), text: textOf(seg) }))
    .filter((s) => s.end >= expandedStart && s.start <= expandedEnd);

  if (!inRange.length) {
    return {
      start_sec: base.start_sec,
      end_sec: base.end_sec,
      reason: 'No aligned transcript chunks in expanded window; kept normalized window.',
      confidence: 0.5,
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
    if (sentenceDone && !fillerTail) {
      endIdx = i;
      break;
    }
    if (i > endIdx + 2) break;
  }

  const adjustedStart = segStart(segments[startIdx]);
  const adjustedEnd = segEnd(segments[endIdx]);
  const clamped = clampDurationWithSegments(adjustedStart, adjustedEnd, segments);

  const startMoved = Math.abs(clamped.start - base.start_sec) >= 0.3;
  const endMoved = Math.abs(clamped.end - base.end_sec) >= 0.3;
  const endText = textOf(segments[endIdx]);
  const startText = textOf(segments[startIdx]);

  let confidence = 0.62;
  if (startsLikeNaturalBoundary(startText)) confidence += 0.14;
  if (endText && endsSentence(endText)) confidence += 0.14;
  if (!endsWithFiller(endText)) confidence += 0.08;
  if (clamped.end - clamped.start >= 15 && clamped.end - clamped.start <= IDEAL_MAX_SEC) confidence += 0.08;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  const reasons = [] as string[];
  if (startMoved) reasons.push('shifted start to nearest natural sentence/thought boundary');
  if (endMoved) reasons.push('extended/trimmed end to complete the speaker payoff');
  if (endsWithFiller(endText)) reasons.push('detected filler-style tail (lower self-contained confidence)');
  if (!reasons.length) reasons.push('raw timestamps already aligned with natural boundaries');

  return {
    start_sec: clamped.start,
    end_sec: clamped.end,
    reason: reasons.join('; '),
    confidence,
  };
}

export async function POST(req: Request) {
  try {
    const { project_id } = await req.json();
    const supabase = await createClient();

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

    const transcriptMaxEnd = segments.reduce((acc, s) => Math.max(acc, segEnd(s)), 0);
    const targetClipCount = targetClipCountForDuration(transcriptMaxEnd);
    const minimumCandidatePool = minCandidatePoolForDuration(transcriptMaxEnd);
    const candidateLimit = Math.max(minimumCandidatePool, targetClipCount * 2);

    const parsed = await analyzeClipCandidates(transcriptRow.full_text as string, segments);
    const aiReturnedCount = Array.isArray(parsed.candidates) ? parsed.candidates.length : 0;

    const scoredCandidates = (parsed.candidates ?? [])
      .slice(0, candidateLimit)
      .map((c: RawCandidate, idx: number) => {
        const rawStart = num(c.raw_start ?? c.start_sec ?? c.adjusted_start);
        const rawEnd = num(c.raw_end ?? c.end_sec ?? c.adjusted_end);
        const modelAdjustedStart = num(c.adjusted_start ?? rawStart);
        const modelAdjustedEnd = num(c.adjusted_end ?? rawEnd);
        const cleaned = adjustBoundaries(modelAdjustedStart, modelAdjustedEnd, segments);

        const openingLine = String(c.opening_line ?? openingLineForWindow(cleaned.start_sec, cleaned.end_sec, segments));
        const closingLine = String(c.closing_line ?? closingLineForWindow(cleaned.start_sec, cleaned.end_sec, segments));
        const passesQuality = passesStandaloneQualityChecks(openingLine, closingLine);

        const naturalStart = clamp10(num(c.natural_start) || (startsLikeNaturalBoundary(openingLine) ? 9 : 5.5));
        const naturalEnd = clamp10(num(c.natural_end) || (endsSentence(closingLine) && !endsWithFiller(closingLine) ? 9 : 5));

        const scored = {
          hook_strength: clamp10(num(c.hook_strength)),
          emotional_intensity: clamp10(num(c.emotional_or_engagement_value ?? c.emotional_intensity)),
          clarity_without_context: clamp10(num(c.clarity_without_context)),
          rewatch_potential: clamp10(num(c.rewatch_potential)),
        };

        const weightedOverall = Number(
          (
            scored.hook_strength * 0.22 +
            scored.clarity_without_context * 0.26 +
            naturalStart * 0.22 +
            naturalEnd * 0.22 +
            scored.rewatch_potential * 0.08
          ).toFixed(2)
        );

        const qualityPenalty = passesQuality ? 0 : 1.2;
        const duration = cleaned.end_sec - cleaned.start_sec;
        const durationPenalty = duration > IDEAL_MAX_SEC ? 0.25 : 0;
        const confidenceBoost = cleaned.confidence >= 0.85 ? 0.35 : cleaned.confidence >= 0.75 ? 0.15 : 0;

        return {
          project_id,
          raw_start: rawStart,
          raw_end: rawEnd,
          start_sec: cleaned.start_sec,
          end_sec: cleaned.end_sec,
          duration_seconds: Number(duration.toFixed(2)),
          title: String(c.title ?? `Clip ${idx + 1}`),
          reason: `${String(c.reason_selected ?? c.reason ?? 'High potential short-form segment')} | Boundary pass: ${String(c.boundary_adjustment_reason ?? cleaned.reason)} | Self-contained confidence: ${cleaned.confidence.toFixed(2)} | Opening: ${openingLine} | Closing: ${closingLine}`,
          self_contained_confidence: clamp10(num(c.standalone_confidence) || Number((cleaned.confidence * 10).toFixed(2))) / 10,
          boundary_adjustment_reason: String(c.boundary_adjustment_reason ?? cleaned.reason),
          opening_line: openingLine,
          closing_line: closingLine,
          natural_start: naturalStart,
          natural_end: naturalEnd,
          ...scored,
          overall_score: clamp10((num(c.overall_score) || weightedOverall || overallScore(scored)) + confidenceBoost - qualityPenalty - durationPenalty),
          rank: idx + 1,
          passes_quality: passesQuality,
        };
      })
      .filter((c) => c.self_contained_confidence >= SELF_CONTAINED_MIN_CONFIDENCE)
      .filter((c) => Number(c.overall_score ?? 0) >= 6.2);

    const filteredCandidates = scoredCandidates;

    const deduped = [...filteredCandidates]
      .sort((a, b) => Number(b.overall_score ?? 0) - Number(a.overall_score ?? 0))
      .reduce<typeof filteredCandidates>((acc, cur) => {
        const curTitle = normalizeTitle(String(cur.title ?? ''));
        const isDuplicate = acc.some((picked) => {
          const pickedTitle = normalizeTitle(String(picked.title ?? ''));
          const sameTitle = curTitle.length > 10 && pickedTitle.length > 10 && curTitle === pickedTitle;
          const sameWindow = isNearDuplicateWindow(
            Number(cur.start_sec ?? 0),
            Number(cur.end_sec ?? 0),
            Number(picked.start_sec ?? 0),
            Number(picked.end_sec ?? 0),
          );
          return sameTitle || sameWindow;
        });

        if (!isDuplicate) acc.push(cur);
        return acc;
      }, []);

    const targetReturnCount = Math.min(deduped.length, Math.max(MIN_RETURN_CLIPS, targetClipCount));
    const ranked = deduped.slice(0, targetReturnCount).map((item, idx) => ({ ...item, rank: idx + 1 }));

    console.log('[analyze] counts', {
      project_id,
      transcript_seconds: Number(transcriptMaxEnd.toFixed(2)),
      target_clip_count: targetClipCount,
      minimum_candidate_pool: minimumCandidatePool,
      candidate_limit: candidateLimit,
      ai_returned: aiReturnedCount,
      after_filtering: filteredCandidates.length,
      after_dedupe: deduped.length,
      final_ranked: ranked.length,
    });

    const dbRows = ranked.map((item) => ({
      project_id: item.project_id,
      start_sec: item.start_sec,
      end_sec: item.end_sec,
      title: item.title,
      reason: item.reason,
      hook_strength: item.hook_strength,
      emotional_intensity: item.emotional_intensity,
      clarity_without_context: item.clarity_without_context,
      rewatch_potential: item.rewatch_potential,
      overall_score: item.overall_score,
      rank: item.rank,
    }));

    await supabase.from('clip_candidates').delete().eq('project_id', project_id);
    const { error: insErr } = await supabase.from('clip_candidates').insert(dbRows);
    if (insErr) throw insErr;

    await supabase.from('projects').update({ status: 'analyzed' }).eq('id', project_id);
    return NextResponse.json({ ok: true, count: ranked.length, candidates: ranked });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Analyze failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
