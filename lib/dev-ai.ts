export function isMockAiEnabled() {
  return process.env.MOCK_AI === 'true' || process.env.NEXT_PUBLIC_MOCK_AI === 'true';
}

export function buildMockTranscript() {
  const segments = [
    { start: 0, end: 6, text: 'A lot of people think growth is about doing more, but it is usually about doing fewer things better.' },
    { start: 6, end: 14, text: 'When you focus on one format, one audience, and one message, your content starts to compound.' },
    { start: 14, end: 24, text: 'That is the real advantage of short form: repetition, clarity, and consistency.' },
    { start: 24, end: 34, text: 'If a clip cannot stand on its own, it should not become a short in the first place.' },
    { start: 34, end: 46, text: 'The goal is not to cut random moments. The goal is to package complete ideas that earn attention fast.' },
  ];

  return {
    language: 'en',
    fullText: segments.map((s) => s.text).join(' '),
    segments,
  };
}

export function buildMockCandidates() {
  return {
    candidates: [
      {
        title: 'Why doing less creates better shorts',
        raw_start: 0,
        raw_end: 24,
        adjusted_start: 0,
        adjusted_end: 24,
        duration_seconds: 24,
        reason_selected: 'Clear hook, context, and payoff in one self-contained idea.',
        reason_rejected: null,
        boundary_adjustment_reason: 'Kept full opening idea for standalone clarity.',
        hook_strength: 90,
        retention_potential: 84,
        story_completeness: 88,
        entertainment_or_emotion: 62,
        educational_value: 86,
        speaker_energy: 72,
        overall_score: 86,
        standalone_confidence: 0.9,
        opening_line: 'A lot of people think growth is about doing more, but it is usually about doing fewer things better.',
        closing_line: 'That is the real advantage of short form: repetition, clarity, and consistency.',
      },
      {
        title: 'Don’t turn random moments into shorts',
        raw_start: 20,
        raw_end: 46,
        adjusted_start: 20,
        adjusted_end: 46,
        duration_seconds: 26,
        reason_selected: 'Strong opinionated framing with a clean final takeaway.',
        reason_rejected: null,
        boundary_adjustment_reason: 'Extended to include the ending payoff.',
        hook_strength: 86,
        retention_potential: 80,
        story_completeness: 89,
        entertainment_or_emotion: 60,
        educational_value: 84,
        speaker_energy: 70,
        overall_score: 85,
        standalone_confidence: 0.88,
        opening_line: 'If a clip cannot stand on its own, it should not become a short in the first place.',
        closing_line: 'The goal is not to cut random moments. The goal is to package complete ideas that earn attention fast.',
      },
    ],
  };
}
