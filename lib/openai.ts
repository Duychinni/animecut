import OpenAI from 'openai';
import { getClipPolicy } from '@/lib/clip-policy';
import { buildMockCandidates, isMockClipAnalysisEnabled } from '@/lib/dev-ai';
import { analyzeTranscriptLocally } from '@/lib/local-analysis';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'local-analysis-disabled-key' });

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
  return getClipPolicy(totalSeconds).candidateCount;
}

function analysisProvider() {
  const raw = (process.env.ANALYSIS_PROVIDER || 'auto').trim().toLowerCase();
  return raw === 'local' || raw === 'openai' ? raw : 'auto';
}

function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function isOpenAiQuotaLikeError(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /429|quota|insufficient_quota|rate limit|billing/i.test(text);
}

function shouldUseLocalFallback(error: unknown) {
  return analysisProvider() !== 'openai' && process.env.LOCAL_ANALYSIS_FALLBACK !== 'false' && isOpenAiQuotaLikeError(error);
}

function buildPrompt(targetCandidates: number, totalSeconds: number) {
  const policy = getClipPolicy(totalSeconds);

  return `You are an expert short-form content editor for TikTok, Instagram Reels, Facebook Reels, and YouTube Shorts.

GOAL:
Do NOT generate random transcript snippets.
Every final clip must feel like a complete short-form video with:
Hook → Context → Main Content → Payoff → Natural Ending.

FULL-TRANSCRIPT REQUIREMENT:
Analyze the ENTIRE transcript window.
Do not stop after finding a few good clips.
Generate MANY candidate clips first, then score/filter/rank them.

DISCOVER THESE MOMENT TYPES:
- strong hooks
- story beginnings
- story endings
- emotional moments
- funny moments
- arguments
- debates
- educational moments
- personal experiences
- curiosity gaps
- surprising facts
- strong opinions
- controversial statements
- high-energy conversations
- statistics
- quotes
- advice
- actionable tips

CANDIDATE GENERATION RULES:
- Use segment windows, not sentence-level snippets.
- For each potential hook, start 3-8 seconds before the hook when helpful for context.
- End 5-15 seconds after payoff when needed for a clean conclusion.
- Prefer complete thought boundaries.
- Avoid starting or ending mid-sentence.
- Avoid openings like "And...", "So...", "But...", "Yeah..." unless absolutely necessary.
- Reject filler-only dialogue.

REEL HOOK TEXT RULES:
- Write a separate "hook_text" for the white title card that appears on the reel.
- The hook_text should be the most viral framing of the moment, not a random transcript snippet.
- Use curiosity, conflict, surprise, emotion, stakes, or an unresolved question.
- Keep it grounded in the transcript. Do not invent facts, names, outcomes, or drama.
- Keep it short enough for a 9:16 title card: 2-8 words, max 38 characters.
- Make it punchier than the title. Avoid bland labels like "Top Moment" unless there is truly no better hook.
- Do not use hashtags, emojis, quotation marks, or all-caps.

VIDEO POLICY FOR THIS TRANSCRIPT WINDOW:
- Generate at least ${targetCandidates} candidate clips.
- Target final clip range: ${policy.targetMin}-${policy.targetMax}, but never more than 20 final clips.
- Expected clip length: ${policy.expectedMinSec}-${policy.expectedMaxSec} seconds.
- Minimum clip length: ${policy.minSec} seconds.
- Maximum clip length: ${policy.maxSec} seconds.
- Only allow shorter-than-minimum clips if they are extremely strong and complete.

SCORING SYSTEM:
Score every candidate from 0-100 using:
- Hook Strength: 25 points
- Retention Potential: 20 points
- Story Completeness: 20 points
- Entertainment / Emotion: 15 points
- Educational Value: 10 points
- Speaker Energy: 10 points

Only strong clips should survive filtering.

REQUIRED OUTPUT:
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
      "reason_rejected": string | null,
      "boundary_adjustment_reason": string,
      "hook_strength": number,
      "retention_potential": number,
      "story_completeness": number,
      "entertainment_or_emotion": number,
      "educational_value": number,
      "speaker_energy": number,
      "overall_score": number,
      "standalone_confidence": number,
      "hook_text": string,
      "opening_line": string,
      "closing_line": string
    }
  ]
}

HARD GROUNDING RULES:
- Use ONLY transcript-proven content.
- Never invent people, events, quotes, or facts.
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
  if (isMockClipAnalysisEnabled()) {
    return buildMockCandidates(segments);
  }

  const provider = analysisProvider();
  if (provider === 'local' || !hasOpenAiKey()) {
    return analyzeTranscriptLocally(transcript, segments);
  }

  try {
    const totalSeconds = segments.reduce((acc, s) => Math.max(acc, Number(s.end ?? s.start ?? 0)), 0);
    const targetCandidates = minCandidatePoolForDuration(totalSeconds);
    const prompt = buildPrompt(targetCandidates, totalSeconds);

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
  } catch (error) {
    if (shouldUseLocalFallback(error)) {
      console.warn('[analysis] OpenAI analysis unavailable; using local transcript analysis.', error);
      return analyzeTranscriptLocally(transcript, segments);
    }
    throw error;
  }
}
