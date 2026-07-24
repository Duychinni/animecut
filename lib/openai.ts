import OpenAI from 'openai';
import { getClipPolicy } from '@/lib/clip-policy';
import { buildMockCandidates, isMockClipAnalysisEnabled } from '@/lib/dev-ai';
import { analyzeTranscriptLocally } from '@/lib/local-analysis';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'local-analysis-disabled-key' });

// Editorial analysis is the quality-critical step. Long sources are split into
// several transcript windows, so short request/total limits caused otherwise
// healthy model calls to fall back to generic local titles and hooks.
const OPENAI_ANALYSIS_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_ANALYSIS_REQUEST_TIMEOUT_MS ?? 120000);
const OPENAI_ANALYSIS_TOTAL_TIMEOUT_MS = Number(process.env.OPENAI_ANALYSIS_TOTAL_TIMEOUT_MS ?? 300000);

type AnalysisResponse = {
  output_text: string;
};

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
    const repaired = await createAnalysisResponse({
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

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} seconds`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function createAnalysisResponse(params: Parameters<typeof openai.responses.create>[0]): Promise<AnalysisResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_ANALYSIS_REQUEST_TIMEOUT_MS);

  try {
    const response = await openai.responses.create({ ...params, store: false }, { signal: controller.signal });
    return response as unknown as AnalysisResponse;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`OpenAI clip analysis request timed out after ${Math.round(OPENAI_ANALYSIS_REQUEST_TIMEOUT_MS / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function isOpenAiTransientError(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network|rate limit|429|quota|insufficient_quota|billing/i.test(text);
}

function shouldUseLocalFallback(error: unknown) {
  return process.env.LOCAL_ANALYSIS_FALLBACK !== 'false' && (analysisProvider() !== 'openai' || isOpenAiTransientError(error) || error instanceof Error);
}

function buildPrompt(targetCandidates: number, totalSeconds: number) {
  const policy = getClipPolicy(totalSeconds);

  return `You are an expert short-form content editor for TikTok, Instagram Reels, Facebook Reels, and YouTube Shorts.

GOAL:
Do NOT generate random transcript snippets.
Every final clip must feel like a complete short-form video with:
Hook -> Context -> Main Content -> Payoff -> Natural Ending.

FULL-TRANSCRIPT REQUIREMENT:
Analyze the ENTIRE transcript window.
Do not stop after finding a few good clips.
Generate MANY candidate clips first, then score/filter/rank them.
For uploaded files, the filename is never editorial evidence and will not be provided as source metadata. Derive every title, hook, name, topic, and claim from the transcript.

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
- End on a completed sentence, punchline, answer, or clear speaker statement. Never end mid-sentence or mid-thought.
- Avoid openings like "And...", "So...", "But...", "Yeah..." unless absolutely necessary.
- Reject filler-only dialogue.
- Reject show packaging rather than editorial content: theme music, opening credits, "welcome to the show," guest introductions, sponsor reads, promotional offers, recaps, intermissions, transition breaks, calls to like/subscribe/follow, sign-offs, end cards, and closing credits must never become reel candidates.
- Never include an intro, outro, sponsor read, recap, long pause, dead-air break, slate, or transition just to reach the target duration. Trim it away when the substantive moment still forms a complete story; otherwise reject the candidate and choose another moment.
- If a candidate overlaps any excluded packaging or break, do not render it. A smaller set of clean reels is better than filling the quota with weak or non-editorial footage.
- A genuine cold open with an immediate substantive story or claim is allowed; do not reject content solely because it occurs near the beginning or end.
- Build an OpusClip-style diverse set: each candidate must cover a distinct viral idea, not a slightly shifted version of another clip.
- Avoid transcript overlap between candidates. If two candidates share the same setup, story beat, or payoff, keep only the stronger one.
- Prefer unique hooks from different parts of the source over multiple clips from the same conversation section.

REEL TITLE RULES:
- The "title" appears above each reel in the project page.
- Write the title as a captivating editorial headline, not a generic subject label or a transcript fragment.
- It should instantly tell the creator what makes this reel worth watching while still making clear what the reel is about.
- Lead with the most interesting specific result, tension, decision, lesson, reveal, or named subject in the clip.
- Create curiosity with specificity and stakes, not vague hype or clickbait.
- Do not use the first words of the transcript as the title.
- Do not copy the opening_line, hook_text, or any raw transcript phrase as the title.
- Never prepend, append, or reuse the source video's title as a reel-title template. Each reel needs its own independently written headline based on that reel's transcript and payoff.
- A construction like "Source Video Phrase: transcript quote" is invalid, even when both halves are factually grounded.
- Make it specific, human-readable, and grounded in the clip.
- Name the person, topic, decision, lesson, or event discussed when the transcript makes it clear.
- If a person is explicitly named in the reel transcript and is central to that moment, make either the title or hook_text name that person. Do not replace a transcript-proven name with a vague pronoun or generic topic.
- Treat names explicitly present in SOURCE METADATA as verified context. Use a recognizable person's name when they are central to this specific reel and the name materially adds clarity, discovery value, or curiosity. Do not force the same famous name into every clip from a source.
- Across the candidate set, create a natural mix of named and topic-led titles. When a recognizable figure such as Joe Rogan or MrBeast is genuinely central to a clip, use that verified name in some of the strongest titles or hooks because it can improve recognition, search value, and virality. Unless identity itself is the story, most candidates should not repeat the same person's name in both the title and hook, and a famous name should not appear mechanically in nearly every candidate.
- A source title or channel can establish who appears in the source, but do not assign an individual statement to that person unless the transcript or source metadata supports it.
- Use 4-10 words in title case or sentence case.
- Avoid invented drama, hashtags, emojis, quotation marks, and all-caps.
- Bad examples: "Yeah, I mean", "I can't back that up", "Did you get ghosts close to black".
- Reject generic constructions such as "X Explains Y", "Why X Matters", "A Conversation About X", or "The Main Idea" when a more specific headline is supported.
- Good examples: "How 100 Cold Calls Built His App", "Why Posting Only Highlights Kills Trust", "Steve-O Challenges the Flat Earth Claim".

REEL HOOK TEXT RULES:
- Write a separate "hook_text" for the white title card that appears on the reel.
- Write it like the first line of a high-performing short, not like a label or summary.
- Its job is to make a viewer feel that they must keep watching to resolve a curiosity gap.
- First identify the most compelling transcript-proven tension, consequence, result, contradiction, confession, disagreement, number, or unanswered question in this specific reel.
- Then turn that idea into a reader-stopping line: a direct question, surprising claim, high-stakes consequence, contrarian statement, or unresolved tension.
- It must be textually and conceptually distinct from the clip title, not a copy or close paraphrase.
- Use curiosity, conflict, surprise, emotion, stakes, or an unresolved question from the actual dialogue.
- Keep it grounded in the transcript. Do not invent facts, names, outcomes, or drama.
- Every factual word in the hook must be supported by the reel transcript, even when the wording is lightly tightened.
- A recognizable name from SOURCE METADATA should be considered for the strongest relevant hooks when that person is central to the reel, the hook remains accurate, and the name makes the hook stronger than the underlying idea alone. Aim for occasional high-value named hooks across a reel set, not zero and not every clip. Do not force a celebrity name into unrelated hooks.
- The hook must make sense before the video starts; reject fragments that only make sense after hearing the previous sentence.
- Prefer specificity over vague hype. Numbers, concrete stakes, named conflicts, and surprising outcomes beat phrases such as "This Is Crazy".
- Keep it short enough for a 9:16 title card: 3-9 words, max 42 characters.
- Make it punchier than the title and suitable for a rounded white reel hook card.
- Preserve question marks or exclamation marks when they make the spoken hook stronger.
- Never use filler hooks such as "Top Moment", "Watch This", "This Is Crazy", "You Need To See This", or "This Is The Part That Matters".
- Do not merely copy the first few transcript words. Choose the strongest hook idea from anywhere inside the reel window.
- Do not use hashtags, emojis, quotation marks, or all-caps.
- Generate five materially different hook options internally before choosing one.
- Score the options for clarity, curiosity, specificity, emotional tension, accuracy, and brevity.
- Save the alternatives and the transcript sentence that proves the chosen hook.

TITLE / HOOK PAIR EXAMPLES:
- title: "Building An App Through Cold Outreach"; hook_text: "100 Calls Every Single Day?"
- title: "The Cost Of Posting Only Highlights"; hook_text: "You're Hiding The Real Work"
- title: "Steve-O's Flat Earth Debate"; hook_text: "Can You Actually Prove It?"

EDITORIAL PLAN (ANALYSIS ONLY IN THIS PHASE):
- Treat every candidate as a story, not merely a timestamp window.
- State the story and central conflict in plain English.
- Identify the primary speaker only when the transcript supports the identity; otherwise use null.
- List supporting speakers only when their identities are transcript-proven.
- Set visual_context_required when reactions, B-roll, a grid, or another participant is necessary to understand the moment.
- Classify scene_type as SINGLE_SPEAKER, TWO_PERSON, THREE_PERSON, FOUR_PERSON, BROLL, PICTURE_IN_PICTURE, or UNKNOWN. Use UNKNOWN when transcript evidence alone cannot prove the visual scene.
- Recommend a layout only when the transcript supports it: SINGLE_SPEAKER_CROP, TWO_PERSON_CONVERSATION, THREE_PERSON_COMPOSITION, PRESERVE_GRID, BROLL_FILL, PICTURE_IN_PICTURE, SPEAKER_WITH_CONTEXT, or SAFE_ORIGINAL.
- The renderer will validate visual facts later. Do not invent people or scene geometry from transcript text.

VIDEO POLICY FOR THIS TRANSCRIPT WINDOW:
- Generate at least ${targetCandidates} candidate clips.
- Target final clip range: ${policy.targetMin}-${policy.targetMax}. The subscriber's plan cap is enforced separately.
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
      "hook_options": [{ "text": string, "score": number }],
      "hook_supporting_quote": string,
      "hook_selection_reason": string,
      "topic": string,
      "moment_type": string,
      "virality_reason": string,
      "story": string,
      "conflict": string,
      "primary_speaker": string | null,
      "supporting_speakers": string[],
      "visual_context_required": boolean,
      "scene_type": "SINGLE_SPEAKER" | "TWO_PERSON" | "THREE_PERSON" | "FOUR_PERSON" | "BROLL" | "PICTURE_IN_PICTURE" | "UNKNOWN",
      "recommended_layout": "SINGLE_SPEAKER_CROP" | "TWO_PERSON_CONVERSATION" | "THREE_PERSON_COMPOSITION" | "PRESERVE_GRID" | "BROLL_FILL" | "PICTURE_IN_PICTURE" | "SPEAKER_WITH_CONTEXT" | "SAFE_ORIGINAL",
      "recommended_thumbnail": {
        "subject": string | null,
        "emotion": string,
        "selection_reason": string
      },
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
  sourceContext = '',
) {
  if (isMockClipAnalysisEnabled()) {
    return {
      ...buildMockCandidates(segments),
      diagnostics: { provider: 'mock', openai_timed_out: false, fallback_used: false, fallback_reason: null },
    };
  }

  const provider = analysisProvider();
  if (provider === 'local' || !hasOpenAiKey()) {
    return {
      ...analyzeTranscriptLocally(transcript, segments, sourceContext),
      diagnostics: {
        provider: 'local',
        openai_timed_out: false,
        fallback_used: true,
        fallback_reason: provider === 'local' ? 'local_provider_configured' : 'openai_key_missing',
      },
    };
  }

  try {
    const totalSeconds = segments.reduce((acc, s) => Math.max(acc, Number(s.end ?? s.start ?? 0)), 0);
    const policy = getClipPolicy(totalSeconds);
    const targetCandidates = minCandidatePoolForDuration(totalSeconds);
    const prompt = buildPrompt(targetCandidates, totalSeconds);

    return await withTimeout((async () => {
      const chunked = segments.length ? chunkSegments(segments) : [];
      const allCandidates: unknown[] = [];

      if (chunked.length) {
        const chunkCandidates = await Promise.all(chunked.map(async (chunk) => {
          const timeline = buildTimeline(chunk);
          const candidatesForWindow = Math.max(
            policy.targetMax * 2,
            Math.ceil(targetCandidates / chunked.length) + 4,
          );
          const res = await createAnalysisResponse({
            model: 'gpt-4.1-mini',
            input: [
              { role: 'system', content: buildPrompt(candidatesForWindow, totalSeconds) },
              { role: 'user', content: `${sourceContext ? `SOURCE METADATA:\n${sourceContext}\n\n` : ''}TIMESTAMPED TRANSCRIPT WINDOW:\n${timeline}` },
            ],
          });

          const parsed = await parseJsonWithRepair(res.output_text);
          return Array.isArray(parsed?.candidates) ? parsed.candidates : [];
        }));
        allCandidates.push(...chunkCandidates.flat());
      } else {
        const userInput = transcript.slice(0, 100000);
        const res = await createAnalysisResponse({
          model: 'gpt-4.1-mini',
          input: [
            { role: 'system', content: prompt },
          { role: 'user', content: `${sourceContext ? `SOURCE METADATA:\n${sourceContext}\n\n` : ''}TRANSCRIPT:\n${userInput}` },
          ],
        });

        const parsed = await parseJsonWithRepair(res.output_text);
        if (Array.isArray(parsed?.candidates)) {
          allCandidates.push(...parsed.candidates);
        }
      }

      const merged = { candidates: allCandidates };
      if (!allCandidates.length) {
        return {
          ...analyzeTranscriptLocally(transcript, segments, sourceContext),
          diagnostics: { provider: 'local', openai_timed_out: false, fallback_used: true, fallback_reason: 'openai_returned_no_candidates' },
        };
      }

      // Window prompts already apply the full editorial rules. A second pass
      // over dozens of verbose candidate objects is slow and can time out,
      // discarding otherwise strong model-written titles and hooks. Keep it
      // opt-in for offline experiments instead of risking production fallback.
      if (process.env.OPENAI_ENABLE_ANALYSIS_REFINEMENT !== 'true') {
        return {
          ...merged,
          diagnostics: { provider: 'openai', openai_timed_out: false, fallback_used: false, fallback_reason: null },
        };
      }

      const refinePrompt = `Review the selected clips again and improve boundaries where needed, but do NOT collapse the list to only a tiny top set.
Preserve up to ${targetCandidates} distinct candidates and return at least ${Math.max(policy.targetMin * 3, policy.targetMax * 2)} when the transcript contains that many complete moments. The route will perform final ranking and deduplication later.
Keep a broad candidate pool, but remove near-duplicate or overlapping clips that use the same transcript section.
Every remaining clip must end on a complete sentence, punchline, answer, or clear statement.
If a clean ending cannot fit inside the allowed duration, reject that candidate instead of cutting the speaker off mid-sentence.
If two clips share the same setup/payoff, keep the more viral and self-contained one.
Remove only clearly broken candidates or duplicate/overlapping candidates.
Rewrite every title as a concise, captivating editorial headline built around the reel's most specific result, tension, decision, lesson, reveal, or named subject. It must make immediate sense and accurately explain why the reel is worth watching; reject generic "X Explains Y" and "Why X Matters" formulas when the transcript supports something sharper. Rewrite every hook_text as a transcript-proven, reader-stopping curiosity gap, tension, high-stakes consequence, specific result, question, or surprising claim. The hook must make sense before playback and create a reason to keep watching; reject vague hype and incomplete transcript fragments. A title and hook_text must never copy or closely paraphrase one another. Do not copy the opening transcript words or opening_line as the title.
For every candidate, retain five hook_options, one hook_supporting_quote, a hook_selection_reason, topic, moment_type, virality_reason, story, conflict, primary_speaker, supporting_speakers, visual_context_required, scene_type, recommended_layout, and recommended_thumbnail.
Return revised JSON only.`;

      const refineRes = await createAnalysisResponse({
        model: 'gpt-4.1-mini',
        input: [
          { role: 'system', content: prompt },
          { role: 'assistant', content: JSON.stringify(merged) },
          { role: 'user', content: refinePrompt },
        ],
      });

      const refined = await parseJsonWithRepair(refineRes.output_text);
      if (Array.isArray(refined?.candidates)) {
        return {
          ...refined,
          diagnostics: { provider: 'openai', openai_timed_out: false, fallback_used: false, fallback_reason: null },
        };
      }

      return {
        ...merged,
        diagnostics: { provider: 'openai', openai_timed_out: false, fallback_used: false, fallback_reason: null },
      };
    })(), OPENAI_ANALYSIS_TOTAL_TIMEOUT_MS, 'OpenAI clip analysis');
  } catch (error) {
    if (shouldUseLocalFallback(error)) {
      console.warn('[analysis] OpenAI analysis unavailable; using local transcript analysis.', error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...analyzeTranscriptLocally(transcript, segments, sourceContext),
        diagnostics: {
          provider: 'local',
          openai_timed_out: /timed out|timeout|aborted/i.test(message),
          fallback_used: true,
          fallback_reason: message.slice(0, 240),
        },
      };
    }
    throw error;
  }
}
