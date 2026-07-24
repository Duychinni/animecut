import { z } from 'zod';

export const semanticClipScoresSchema = z.object({
  hook_strength: z.coerce.number().min(0).max(100),
  payoff_value: z.coerce.number().min(0).max(100),
  standalone_clarity: z.coerce.number().min(0).max(100),
  emotion_novelty: z.coerce.number().min(0).max(100),
  shareability: z.coerce.number().min(0).max(100),
  semantic_pacing: z.coerce.number().min(0).max(100),
  explanations: z.object({
    hook_strength: z.string().max(240),
    payoff_value: z.string().max(240),
    standalone_clarity: z.string().max(240),
    emotion_novelty: z.string().max(240),
    shareability: z.string().max(240),
    semantic_pacing: z.string().max(240),
  }).partial().default({}),
});

export type SemanticClipScores = z.infer<typeof semanticClipScoresSchema>;

export type ClipTechnicalMetrics = {
  duration_seconds: number;
  speech_onset_seconds: number;
  silence_ratio: number;
  longest_silence_seconds: number;
  integrated_loudness: number | null;
  audio_peak_or_clipping_indicator: boolean | null;
  scene_boundary_count: number | null;
  scene_boundary_timestamps: number[];
  black_frame_ratio: number | null;
  frozen_frame_ratio: number | null;
  blur_score: number | null;
  video_width: number | null;
  video_height: number | null;
  frame_rate: number | null;
};

export type ClipScorePenalty = {
  reason:
    | 'starts_mid_sentence_or_missing_context'
    | 'ends_before_payoff_or_mid_sentence'
    | 'non_meaningful_opening_silence'
    | 'excessive_dead_air'
    | 'major_black_or_frozen_section'
    | 'low_transcript_confidence';
  points: number;
};

export type ClipScoreResult = {
  component_scores: {
    hook_strength: number;
    payoff_value: number;
    standalone_clarity: number;
    emotion_novelty: number;
    shareability: number;
    semantic_pacing: number;
    pacing: number;
    technical_quality: number;
  };
  penalties: ClipScorePenalty[];
  final_score: number;
  label: 'Weak' | 'Needs Work' | 'Good' | 'Strong' | 'Excellent' | 'Exceptional';
  confidence: number;
  score_reasons: string[];
};

type TranscriptSegment = { start?: number; end?: number; text?: string };

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function round(value: number) {
  return Math.round(clamp(value));
}

export function clipScoreLabel(score: number): ClipScoreResult['label'] {
  if (score >= 95) return 'Exceptional';
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Strong';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Needs Work';
  return 'Weak';
}

export function transcriptTechnicalMetrics(
  segments: TranscriptSegment[],
  startSeconds: number,
  endSeconds: number,
): ClipTechnicalMetrics {
  const duration = Math.max(0.01, endSeconds - startSeconds);
  const speech = segments
    .map((segment) => ({
      start: Math.max(startSeconds, Number(segment.start ?? startSeconds)),
      end: Math.min(endSeconds, Number(segment.end ?? segment.start ?? startSeconds)),
      text: String(segment.text ?? '').trim(),
    }))
    .filter((segment) => segment.text && segment.end > segment.start && segment.end > startSeconds && segment.start < endSeconds)
    .sort((a, b) => a.start - b.start);

  const speechOnset = speech.length ? Math.max(0, speech[0].start - startSeconds) : duration;
  let speechSeconds = 0;
  let longestSilence = speechOnset;
  let cursor = startSeconds;
  for (const segment of speech) {
    longestSilence = Math.max(longestSilence, Math.max(0, segment.start - cursor));
    speechSeconds += Math.max(0, segment.end - Math.max(cursor, segment.start));
    cursor = Math.max(cursor, segment.end);
  }
  longestSilence = Math.max(longestSilence, Math.max(0, endSeconds - cursor));

  return {
    duration_seconds: Number(duration.toFixed(3)),
    speech_onset_seconds: Number(speechOnset.toFixed(3)),
    silence_ratio: Number(clamp(1 - speechSeconds / duration, 0, 1).toFixed(4)),
    longest_silence_seconds: Number(longestSilence.toFixed(3)),
    integrated_loudness: null,
    audio_peak_or_clipping_indicator: null,
    scene_boundary_count: null,
    scene_boundary_timestamps: [],
    black_frame_ratio: null,
    frozen_frame_ratio: null,
    blur_score: null,
    video_width: null,
    video_height: null,
    frame_rate: null,
  };
}

function speechOnsetScore(seconds: number) {
  if (seconds <= 0.7) return 100;
  if (seconds <= 1.5) return 100 - ((seconds - 0.7) / 0.8) * 22;
  return clamp(78 - (seconds - 1.5) * 24);
}

function silenceQualityScore(ratio: number, longest: number) {
  const ratioPenalty = clamp(ratio, 0, 1) * 70;
  const gapPenalty = Math.max(0, longest - 0.8) * 8;
  return clamp(100 - ratioPenalty - gapPenalty);
}

export function calculateAiClipScore(input: {
  semantic: SemanticClipScores;
  technicalMetrics: ClipTechnicalMetrics;
  technicalQuality?: number;
  startsMidSentence?: boolean;
  endsBeforePayoff?: boolean;
  openingVisualHookMeaningful?: boolean;
  transcriptConfidence?: number;
  scoreConfidence?: number;
}): ClipScoreResult {
  const semantic = semanticClipScoresSchema.parse(input.semantic);
  const metrics = input.technicalMetrics;
  const pacing = round(
    semantic.semantic_pacing * 0.60
    + silenceQualityScore(metrics.silence_ratio, metrics.longest_silence_seconds) * 0.25
    + speechOnsetScore(metrics.speech_onset_seconds) * 0.15,
  );
  const technicalQuality = round(input.technicalQuality ?? 85);
  const penalties: ClipScorePenalty[] = [];

  if (input.startsMidSentence) penalties.push({ reason: 'starts_mid_sentence_or_missing_context', points: 8 });
  if (input.endsBeforePayoff) penalties.push({ reason: 'ends_before_payoff_or_mid_sentence', points: 10 });
  if (metrics.speech_onset_seconds > 1.5 && !input.openingVisualHookMeaningful) {
    penalties.push({ reason: 'non_meaningful_opening_silence', points: 5 });
  }
  if (metrics.silence_ratio > 0.25) penalties.push({ reason: 'excessive_dead_air', points: 5 });
  if ((metrics.black_frame_ratio ?? 0) >= 0.12 || (metrics.frozen_frame_ratio ?? 0) >= 0.12) {
    penalties.push({ reason: 'major_black_or_frozen_section', points: 8 });
  }
  if ((input.transcriptConfidence ?? 1) < 0.55) penalties.push({ reason: 'low_transcript_confidence', points: 5 });

  const rawScore =
    semantic.hook_strength * 0.25
    + semantic.payoff_value * 0.20
    + semantic.standalone_clarity * 0.15
    + semantic.emotion_novelty * 0.15
    + semantic.shareability * 0.10
    + pacing * 0.10
    + technicalQuality * 0.05;
  const penaltyTotal = penalties.reduce((total, penalty) => total + penalty.points, 0);
  const roundedScore = Math.max(0, Math.min(100, Math.round(rawScore - penaltyTotal)));
  const nearPerfectComponents = [
    semantic.hook_strength,
    semantic.payoff_value,
    semantic.standalone_clarity,
    semantic.emotion_novelty,
    semantic.shareability,
    semantic.semantic_pacing,
  ].every((score) => score >= 97);
  const qualifiesForPerfectScore = nearPerfectComponents
    && pacing >= 95
    && technicalQuality >= 95
    && penalties.length === 0
    && (input.scoreConfidence ?? 0.75) >= 0.9;
  // Scores of 95-100 must be rare. A perfect score requires near-perfect
  // evidence in every component; being the best candidate in a weak source
  // never raises or normalizes its score.
  const finalScore = roundedScore === 100 && !qualifiesForPerfectScore ? 99 : roundedScore;

  const reasonEntries = [
    ['hook_strength', semantic.hook_strength, semantic.explanations.hook_strength],
    ['payoff_value', semantic.payoff_value, semantic.explanations.payoff_value],
    ['standalone_clarity', semantic.standalone_clarity, semantic.explanations.standalone_clarity],
    ['emotion_novelty', semantic.emotion_novelty, semantic.explanations.emotion_novelty],
    ['shareability', semantic.shareability, semantic.explanations.shareability],
  ] as const;
  const fallbackReasons: Record<string, string> = {
    hook_strength: 'Immediate hook',
    payoff_value: 'Clear payoff',
    standalone_clarity: 'Standalone clarity',
    emotion_novelty: 'Strong emotion or novelty',
    shareability: 'Shareable moment',
  };
  const scoreReasons = reasonEntries
    .filter(([, value]) => value >= 70)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key, , explanation]) => explanation?.trim() || fallbackReasons[key]);
  if (scoreReasons.length < 3 && metrics.silence_ratio <= 0.12) scoreReasons.push('Low dead air');

  return {
    component_scores: {
      hook_strength: round(semantic.hook_strength),
      payoff_value: round(semantic.payoff_value),
      standalone_clarity: round(semantic.standalone_clarity),
      emotion_novelty: round(semantic.emotion_novelty),
      shareability: round(semantic.shareability),
      semantic_pacing: round(semantic.semantic_pacing),
      pacing,
      technical_quality: technicalQuality,
    },
    penalties,
    final_score: finalScore,
    label: clipScoreLabel(finalScore),
    confidence: Number(clamp(input.scoreConfidence ?? 0.75, 0, 1).toFixed(2)),
    score_reasons: scoreReasons.slice(0, 3),
  };
}
