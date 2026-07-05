import OpenAI from 'openai';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function stripCodeFences(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function extractLikelyJson(text: string) {
  const cleaned = stripCodeFences(text);
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

function tryParseJson(text: string) {
  const raw = extractLikelyJson(text);
  try {
    return JSON.parse(raw);
  } catch {
    const noTrailingCommas = raw.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(noTrailingCommas);
  }
}

async function parseJsonWithRepair(rawText: string) {
  try {
    return tryParseJson(rawText);
  } catch (firstError) {
    const repaired = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content:
            'Fix the user-provided JSON to be strictly valid JSON. Keep the same data/keys/values as much as possible. Return JSON only.',
        },
        { role: 'user', content: rawText },
      ],
    });

    try {
      return tryParseJson(repaired.output_text);
    } catch {
      throw firstError;
    }
  }
}

function minCandidatePoolForDuration(totalSeconds: number) {
  const minutes = totalSeconds / 60;
  if (minutes < 5) return 20;
  if (minutes <= 15) return 40;
  if (minutes <= 30) return 60;
  if (minutes <= 60) return 80;
  return 100;
}

function buildPrompt(targetCandidates: number) {
  return `You are a short-form clip selector for podcast/interview/talking-head content.

Core objective:
Select complete, self-contained short clips that start and end naturally.
Do NOT return random excerpts.
You must search exhaustively and produce a LARGE candidate set before ranking.
Do NOT stop after finding only a few good clips.

Process (required):
1) Candidate discovery:
   - scan the entire provided transcript window
   - find moments with strong hook, opinion, conflict, story beat, emotional punch, insight, humor, surprise, controversial claim, educational payoff, or high-energy delivery.
2) Boundary cleanup:
   - for each raw candidate, inspect nearby transcript lines.
   - move start/end to natural speech boundaries.
   - keep a short lead-in if needed for clarity.
   - preserve payoff even if slightly longer.
3) Exhaustive coverage:
   - different start/end timestamps are different candidates.
   - overlapping moments may still be valid if the hook point differs.
   - do not reject clips just because they occur in the same conversation.

Quality rules:
- Must make sense to a new viewer with no prior context.
- Must begin at a sentence/clause boundary (not mid-thought).
- Avoid openings like: "and", "but", "so", "because", "then" unless still fully clear.
- Must end after the point is complete and NOT on filler tails ("you know", "like", "so basically").
- Favor complete thoughts over shortness.

Clip targets:
- Prefer 12-45s when possible, while still respecting the natural length of the complete thought (can go shorter only if the moment is genuinely complete and strong, and can go longer only if needed to preserve full thought).
- Do NOT force every clip to the same duration.
- Avoid over-selecting ultra-short 8-10s fragments unless they clearly stand alone and have strong payoff.
- Return AT LEAST ${targetCandidates} candidate clips if the transcript window contains them.
- Do NOT limit yourself to only a few “best” clips.

Return ONLY valid JSON in this exact shape:
{
  "candidates": [
    {
      "title": string,
      "raw_start": number,
      "raw_end": number,
      "adjusted_start": number,
      "adjusted_end": number,
      "duration_seconds": number,
      "reason_selected": string,
      "boundary_adjustment_reason": string,
      "hook_strength": number,
      "clarity_without_context": number,
      "emotional_or_engagement_value": number,
      "payoff_strength": number,
      "natural_start": number,
      "natural_end": number,
      "rewatch_potential": number,
      "overall_score": number,
      "standalone_confidence": number,
      "opening_line": string,
      "closing_line": string
    }
  ]
}

Hard grounding rules:
- Use ONLY transcript-proven content.
- Never invent people/events/quotes/facts.
- Timestamps must align to the transcript timeline.`;
}

function buildTimeline(segments: Array<{ start?: number; end?: number; text?: string }>) {
  return segments
    .map((s) => {
      const start = Number(s.start ?? 0);
      const end = Number(s.end ?? start);
      return `[${start.toFixed(1)}-${end.toFixed(1)}] ${(s.text ?? '').trim()}`;
    })
    .join('\n');
}

function chunkSegments(
  segments: Array<{ start?: number; end?: number; text?: string }>,
  chunkSize = 220,
  overlap = 40,
) {
  if (segments.length <= chunkSize) return [segments];
  const chunks: Array<Array<{ start?: number; end?: number; text?: string }>> = [];
  for (let i = 0; i < segments.length; i += Math.max(1, chunkSize - overlap)) {
    const chunk = segments.slice(i, i + chunkSize);
    if (!chunk.length) break;
    chunks.push(chunk);
    if (i + chunkSize >= segments.length) break;
  }
  return chunks;
}

export async function analyzeClipCandidates(
  transcript: string,
  segments: Array<{ start?: number; end?: number; text?: string }> = [],
) {
  const totalSeconds = segments.reduce((acc, s) => Math.max(acc, Number(s.end ?? s.start ?? 0)), 0);
  const targetCandidates = minCandidatePoolForDuration(totalSeconds);
  const prompt = buildPrompt(targetCandidates);

  const chunked = segments.length ? chunkSegments(segments) : [];
  const allCandidates: unknown[] = [];

  if (chunked.length) {
    for (const chunk of chunked) {
      const timeline = buildTimeline(chunk);
      const res = await openai.responses.create({
        model: 'gpt-4.1-mini',
        input: [
          { role: 'system', content: prompt },
          { role: 'user', content: `TIMESTAMPED TRANSCRIPT WINDOW:\n${timeline}` },
        ],
      });

      const parsed = await parseJsonWithRepair(res.output_text);
      if (Array.isArray(parsed?.candidates)) {
        allCandidates.push(...parsed.candidates);
      }
    }
  } else {
    const userInput = transcript.slice(0, 100000);
    const res = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: prompt },
        { role: 'user', content: userInput },
      ],
    });

    const parsed = await parseJsonWithRepair(res.output_text);
    if (Array.isArray(parsed?.candidates)) {
      allCandidates.push(...parsed.candidates);
    }
  }

  const merged = { candidates: allCandidates };

  const refinePrompt = `Review the selected clips again and improve boundaries where needed, but do NOT collapse the list to only a tiny top set.
Keep a broad candidate pool.
Remove only clearly broken candidates.
Return revised JSON only.`;

  const refineRes = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: prompt },
      { role: 'assistant', content: JSON.stringify(merged) },
      { role: 'user', content: refinePrompt },
    ],
  });

  const refined = await parseJsonWithRepair(refineRes.output_text);
  if (Array.isArray(refined?.candidates)) {
    return refined;
  }

  return merged;
}
