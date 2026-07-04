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

export async function analyzeClipCandidates(
  transcript: string,
  segments: Array<{ start?: number; end?: number; text?: string }> = [],
) {
  const prompt = `You are a short-form clip selector for podcast/interview/talking-head content.

Core objective:
Select complete, self-contained short clips that start and end naturally.
Do NOT return random excerpts.

Process (required):
1) Candidate discovery:
   - find moments with strong hook, opinion, conflict, story beat, emotional punch, insight, humor, surprise, or controversial claim.
2) Boundary cleanup:
   - for each raw candidate, inspect nearby transcript lines.
   - move start/end to natural speech boundaries.
   - keep a short lead-in if needed for clarity.
   - preserve payoff even if slightly longer.

Quality rules:
- Must make sense to a new viewer with no prior context.
- Must begin at a sentence/clause boundary (not mid-thought).
- Avoid openings like: "and", "but", "so", "because", "then" unless still fully clear.
- Must end after the point is complete and NOT on filler tails ("you know", "like", "so basically").
- Reject clips that still feel incomplete after cleanup.
- Favor complete thoughts over shortness.

Clip targets:
- Prefer 15-45s (can go longer only if needed to preserve full thought).
- Return ONLY best 5.

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
- Timestamps must align to the transcript timeline.

Before finalizing each clip, verify:
1. Would this make sense to a new viewer with no prior context?
2. Does the first line sound like a real beginning?
3. Does the last line sound complete/satisfying?
4. Would this feel intentional if posted as a short?
5. Is there a clear hook and payoff?
If any answer is no, reject that clip.`;

  const timeline = segments
    .slice(0, 1200)
    .map((s) => {
      const start = Number(s.start ?? 0);
      const end = Number(s.end ?? start);
      return `[${start.toFixed(1)}-${end.toFixed(1)}] ${(s.text ?? '').trim()}`;
    })
    .join('\n');

  const userInput = timeline.trim().length
    ? `TIMESTAMPED TRANSCRIPT:\n${timeline}`
    : transcript.slice(0, 100000);

  const res = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: prompt },
      { role: 'user', content: userInput },
    ],
  });

  const firstPassText = res.output_text;
  const firstPass = await parseJsonWithRepair(firstPassText);

  const refinePrompt = `Review the selected clips again and remove any clip that:
- starts mid-thought
- ends before the point is finished
- depends too much on earlier context
- has weak opening words
- has weak payoff

Then improve boundaries again.
Favor complete thoughts over shorter clips.
It is better for a clip to be slightly longer and feel complete than shorter and feel cut off.
Return revised JSON only.`;

  const refineRes = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: [
      { role: 'system', content: prompt },
      { role: 'user', content: userInput },
      { role: 'assistant', content: JSON.stringify(firstPass) },
      { role: 'user', content: refinePrompt },
    ],
  });

  const refinedText = refineRes.output_text;
  return await parseJsonWithRepair(refinedText);
}
