import { getClipPolicy, getTargetClipCount } from '@/lib/clip-policy';

export function isMockAiEnabled() {
  return process.env.MOCK_AI === 'true' || process.env.NEXT_PUBLIC_MOCK_AI === 'true';
}

const MOCK_LINES = [
  'A lot of creators think growth is about posting more, but the real unlock is making one clear idea impossible to ignore.',
  'The first three seconds need to tell the viewer why this moment matters before they decide to swipe away.',
  'When a clip has a clean setup, a little tension, and a payoff, it starts to feel like a complete story.',
  'That is why the best short videos are not random highlights, they are packaged thoughts with a beginning and an ending.',
  'If the speaker is explaining a lesson, the clip should carry the full lesson instead of only the most dramatic sentence.',
  'The title, captions, crop, and pacing all have one job, which is helping the viewer understand the point faster.',
  'A good reel can come from a quiet interview if the idea is specific, surprising, and useful enough to repeat.',
  'That means the editor should choose moments with context, consequence, and a final line that feels satisfying.',
  'The mistake is chasing every energetic second, because energy without clarity usually turns into noise.',
  'The better move is to find the sentence that opens curiosity, then keep enough context for the payoff to land.',
  'When the source is longer, there are usually more usable stories, but only the strongest ones deserve to be rendered.',
  'That is the balance for a real clipping product, generate enough options to feel valuable without wasting compute.',
];

function safeSourceDurationSeconds(value: unknown) {
  const seconds = Number(value ?? 0);
  if (Number.isFinite(seconds) && seconds >= 45) return Math.min(seconds, 3 * 60 * 60);
  return 8 * 60;
}

export function buildMockTranscript(sourceDurationSeconds?: number | null) {
  const totalSeconds = safeSourceDurationSeconds(sourceDurationSeconds);
  const segmentLength = 8;
  const segmentCount = Math.max(6, Math.ceil(totalSeconds / segmentLength));
  const segments = Array.from({ length: segmentCount }, (_, idx) => {
    const start = idx * segmentLength;
    const end = Math.min(totalSeconds, start + segmentLength);
    const cycle = Math.floor(idx / MOCK_LINES.length) + 1;
    const base = MOCK_LINES[idx % MOCK_LINES.length];
    const text = cycle === 1 ? base : `${base} This later example reinforces the same lesson from angle ${cycle}.`;
    return { start, end, text };
  }).filter((segment) => segment.end > segment.start);

  return {
    language: 'en',
    fullText: segments.map((s) => s.text).join(' '),
    segments,
  };
}

export function buildMockCandidates(segments: Array<{ start?: number; end?: number; text?: string }> = []) {
  const totalSeconds = segments.reduce((acc, s) => Math.max(acc, Number(s.end ?? s.start ?? 0)), 0);
  const policy = getClipPolicy(totalSeconds || 8 * 60);
  const targetCount = getTargetClipCount(totalSeconds || 8 * 60);
  const titles = [
    'Why this moment becomes a reel',
    'The hook that keeps viewers watching',
    'How to turn context into payoff',
    'Why random highlights do not work',
    'The short-form editing rule',
    'What makes a clip feel complete',
    'The reason longer videos need ranking',
    'How to pick only the best moments',
    'The viewer retention test',
    'Why clarity beats raw energy',
  ];

  const candidates = Array.from({ length: Math.max(targetCount, policy.targetMin) }, (_, idx) => {
    const duration = Math.min(policy.expectedMaxSec, Math.max(policy.expectedMinSec, policy.expectedMinSec + (idx % 3) * 8));
    const usableEnd = Math.max(duration, totalSeconds || 8 * 60);
    const spacing = Math.max(duration + 8, Math.floor(usableEnd / Math.max(1, targetCount)));
    const rawStart = Math.min(Math.max(0, idx * spacing), Math.max(0, usableEnd - duration));
    const rawEnd = Math.min(usableEnd, rawStart + duration);
    const opening = segments.find((s) => Number(s.end ?? 0) >= rawStart)?.text ?? MOCK_LINES[idx % MOCK_LINES.length];
    const closing = segments.slice().reverse().find((s) => Number(s.start ?? 0) <= rawEnd)?.text ?? MOCK_LINES[(idx + 3) % MOCK_LINES.length];
    const score = Math.max(78, 92 - idx);

    return {
      title: titles[idx % titles.length],
      raw_start: rawStart,
      raw_end: rawEnd,
      adjusted_start: rawStart,
      adjusted_end: rawEnd,
      duration_seconds: rawEnd - rawStart,
      reason_selected: 'Mock candidate with hook, context, and payoff for local testing without AI token usage.',
      reason_rejected: null,
      boundary_adjustment_reason: 'Aligned to a complete mock thought window.',
      hook_strength: score,
      retention_potential: score - 2,
      story_completeness: score,
      entertainment_or_emotion: Math.max(70, score - 12),
      educational_value: Math.max(75, score - 4),
      speaker_energy: Math.max(72, score - 8),
      overall_score: score,
      standalone_confidence: 0.86,
      opening_line: opening,
      closing_line: closing,
    };
  });

  return { candidates };
}
