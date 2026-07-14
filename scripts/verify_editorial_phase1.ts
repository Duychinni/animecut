import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeTranscriptLocally } from '../lib/local-analysis';
import { isNaturalEditorialHook, isNaturalEditorialTitle } from '../lib/editorial-plan';
import { getTargetClipCount } from '../lib/clip-policy';

type Json3Event = {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
};

function transcriptSegments(events: Json3Event[]) {
  return events
    .map((event) => {
      const text = (event.segs ?? []).map((segment) => segment.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
      const start = Math.max(0, Number(event.tStartMs ?? 0) / 1000);
      const duration = Math.max(0.08, Number(event.dDurationMs ?? 0) / 1000);
      return { start, end: start + duration, text };
    })
    .filter((segment) => segment.text && segment.text !== '\n');
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error('Usage: tsx scripts/verify_editorial_phase1.ts <youtube-json3> <output-json>');
  }

  const json3 = JSON.parse(await readFile(path.resolve(inputPath), 'utf8')) as { events?: Json3Event[] };
  const segments = transcriptSegments(json3.events ?? []);
  const transcript = segments.map((segment) => segment.text).join(' ');
  const analysis = analyzeTranscriptLocally(transcript, segments);
  const candidatePool = analysis.candidates;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const targetCount = getTargetClipCount(Math.max(...segments.map((segment) => segment.end), 0));
  const selected: typeof candidatePool = [];
  const titleCounts = new Map<string, number>();

  for (const uniqueTitlesOnly of [true, false]) {
    for (const candidate of candidatePool) {
      if (selected.length >= targetCount || selected.includes(candidate)) continue;
      const titleKey = normalize(candidate.title);
      const priorTitleCount = titleCounts.get(titleKey) ?? 0;
      if (uniqueTitlesOnly && priorTitleCount > 0) continue;
      if (!uniqueTitlesOnly && priorTitleCount >= 2) continue;
      const overlapsSelected = selected.some((picked) => {
        const overlap = Math.max(0, Math.min(candidate.adjusted_end, picked.adjusted_end) - Math.max(candidate.adjusted_start, picked.adjusted_start));
        const minDuration = Math.max(1, Math.min(candidate.duration_seconds, picked.duration_seconds));
        return overlap / minDuration >= 0.62;
      });
      if (overlapsSelected) continue;
      selected.push(candidate);
      titleCounts.set(titleKey, priorTitleCount + 1);
    }
  }
  const candidates = selected;
  const report = {
    generated_at: new Date().toISOString(),
    transcript_segments: segments.length,
    transcript_duration_seconds: Number(Math.max(...segments.map((segment) => segment.end), 0).toFixed(2)),
    candidate_pool_count: candidatePool.length,
    target_final_count: targetCount,
    candidate_count: candidates.length,
    quality: {
      invalid_titles: candidates.filter((candidate) => !isNaturalEditorialTitle(candidate.title)).length,
      invalid_selected_hooks: candidates.filter((candidate) => !isNaturalEditorialHook(candidate.hook_text)).length,
      unique_titles: new Set(candidates.map((candidate) => normalize(candidate.title))).size,
      unique_selected_hooks: new Set(candidates.map((candidate) => normalize(candidate.hook_text))).size,
      candidates_with_five_hooks: candidates.filter((candidate) => candidate.editorial_plan?.hook_options?.length >= 5).length,
      candidates_with_editorial_plan: candidates.filter((candidate) => candidate.editorial_plan?.version === 1).length,
    },
    candidates: candidates.map((candidate, index) => ({
      rank: index + 1,
      start: Number(candidate.adjusted_start.toFixed(2)),
      end: Number(candidate.adjusted_end.toFixed(2)),
      duration: Number(candidate.duration_seconds.toFixed(2)),
      title: candidate.title,
      hook: candidate.hook_text,
      hook_options: candidate.editorial_plan?.hook_options?.map((option) => option.text) ?? [],
      story: candidate.editorial_plan?.story ?? null,
      conflict: candidate.editorial_plan?.conflict ?? null,
      primary_speaker: candidate.editorial_plan?.primary_speaker ?? null,
      supporting_speakers: candidate.editorial_plan?.supporting_speakers ?? [],
      visual_context_required: candidate.editorial_plan?.visual_context_required ?? null,
      scene_type: candidate.editorial_plan?.scene_type ?? null,
      recommended_layout: candidate.editorial_plan?.recommended_layout ?? null,
      recommended_thumbnail: candidate.editorial_plan?.recommended_thumbnail ?? null,
      score: candidate.overall_score,
    })),
  };

  await writeFile(path.resolve(outputPath), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
