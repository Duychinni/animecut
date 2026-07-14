import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { analyzeTranscriptLocally } from '../lib/local-analysis';
import { DEFAULT_CAPTION_PRESET_ID, getCaptionPresetById } from '../lib/caption-presets';
import { segmentsToCapcutAss } from '../lib/srt';
import { extractBestVideoThumbnail, extractVideoThumbnail, renderVerticalClip, validateRenderedVideo } from '../lib/ffmpeg';

type Json3Event = { tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> };
type Candidate = ReturnType<typeof analyzeTranscriptLocally>['candidates'][number];

const [source, transcriptPath, outputDir, baselinePath] = process.argv.slice(2);
if (!source || !transcriptPath || !outputDir) {
  throw new Error('usage: verify_full_editorial_acceptance.ts <source_mp4> <youtube_json3> <output_dir> [baseline_json]');
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function overlapRatio(a: Candidate, b: Candidate) {
  const overlap = Math.max(0, Math.min(a.adjusted_end, b.adjusted_end) - Math.max(a.adjusted_start, b.adjusted_start));
  return overlap / Math.max(1, Math.min(a.duration_seconds, b.duration_seconds));
}

function selectFinal(pool: Candidate[], count = 8) {
  const selected: Candidate[] = [];
  const titleCounts = new Map<string, number>();
  for (const uniqueOnly of [true, false]) {
    for (const candidate of pool) {
      if (selected.length >= count || selected.includes(candidate)) continue;
      const title = normalize(candidate.title);
      const prior = titleCounts.get(title) ?? 0;
      if ((uniqueOnly && prior > 0) || (!uniqueOnly && prior >= 2)) continue;
      if (selected.some((picked) => overlapRatio(candidate, picked) >= 0.62)) continue;
      selected.push(candidate);
      titleCounts.set(title, prior + 1);
    }
  }
  return selected;
}

const STOP = new Set(['the','a','an','and','or','to','of','in','on','for','with','is','are','was','were','that','this','why','how','behind']);
function semanticTokens(candidate: Candidate) {
  return new Set(normalize(`${candidate.title} ${candidate.editorial_plan.story} ${candidate.editorial_plan.conflict}`)
    .split(' ').filter((word) => word.length > 2 && !STOP.has(word)));
}
function semanticSimilarity(a: Candidate, b: Candidate) {
  const left = semanticTokens(a); const right = semanticTokens(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, new Set([...left, ...right]).size);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const raw = JSON.parse(await readFile(transcriptPath, 'utf8')) as { events?: Json3Event[] };
  const segments = (raw.events ?? []).map((event) => {
    const start = Number(event.tStartMs ?? 0) / 1000;
    const text = (event.segs ?? []).map((segment) => segment.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    return { start, end: start + Math.max(0.08, Number(event.dDurationMs ?? 0) / 1000), text };
  }).filter((segment) => segment.text);
  const transcript = segments.map((segment) => segment.text).join(' ');
  const pool = analyzeTranscriptLocally(transcript, segments).candidates;
  const selected = selectFinal(pool, 8);
  if (selected.length !== 8) throw new Error(`Expected exactly 8 selected clips, got ${selected.length}`);

  const semanticMatrix = selected.map((left) => selected.map((right) => Number(semanticSimilarity(left, right).toFixed(4))));
  const timelineMatrix = selected.map((left) => selected.map((right) => Number(overlapRatio(left, right).toFixed(4))));
  const selectedSet = new Set(selected);
  const rejected = pool.filter((candidate) => !selectedSet.has(candidate)).map((candidate) => {
    const duplicate = selected.find((picked) => normalize(candidate.title) === normalize(picked.title));
    const overlap = selected.find((picked) => overlapRatio(candidate, picked) >= 0.62);
    return {
      start: candidate.adjusted_start, end: candidate.adjusted_end, title: candidate.title,
      reason: overlap ? `timeline_overlap_with_selected_rank_${selected.indexOf(overlap) + 1}`
        : duplicate ? `semantic_duplicate_of_selected_rank_${selected.indexOf(duplicate) + 1}`
          : 'lower_ranked_after_target_of_8_was_met',
    };
  });

  const clips: Array<Record<string, unknown>> = [];
  const layoutDuration: Record<string, number> = {};
  const debugDir = process.env.SMART_REFRAME_DEBUG_DIR?.trim() || path.join(process.cwd(), 'tmp', 'reframe-debug');
  const python = process.env.SMART_REFRAME_PYTHON || 'python';
  const preset = getCaptionPresetById(DEFAULT_CAPTION_PRESET_ID);

  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const rank = index + 1;
    const id = `clip-${String(rank).padStart(2, '0')}`;
    const clipDir = path.join(outputDir, id);
    await mkdir(clipDir, { recursive: true });
    const finalMp4 = path.join(clipDir, `${id}.final.mp4`);
    const metadataPath = path.join(clipDir, `${id}.crop-layout.json`);
    const assPath = path.join(clipDir, `${id}.captions.ass`);
    const thumbnailPath = path.join(clipDir, `${id}.thumbnail.jpg`);
    const firstFramePath = path.join(clipDir, `${id}.first-frame.jpg`);
    const overlayPath = path.join(clipDir, `${id}.debug-overlay.mp4`);
    const overlayCommandPath = path.join(clipDir, `${id}.debug-overlay.ffmpeg-command.txt`);
    const qaPath = path.join(clipDir, `${id}.post-render-qa.json`);

    await writeFile(assPath, segmentsToCapcutAss(segments, candidate.adjusted_start, candidate.adjusted_end, preset), 'utf8');
    process.env.SMART_REFRAME_METADATA_PATH = metadataPath;
    process.env.SMART_REFRAME_DEBUG_CLIP_ID = id;
    process.env.DEBUG_REFRAME_SAVE_JSON = 'true';
    await renderVerticalClip({
      inputPath: source, outputPath: finalMp4,
      startSec: candidate.adjusted_start, endSec: candidate.adjusted_end,
      srtPath: assPath, captionsEnabled: true,
      captionTemplate: preset.caption_template, captionFont: preset.caption_font,
      hookTextEnabled: true, hookText: candidate.hook_text,
      autoReframe: true, reframeMode: 'smart', framingMode: 'auto', motionTracking: true,
      debugClipId: id, debugCandidateId: `acceptance-${id}`,
      editorialPlan: candidate.editorial_plan,
    });
    const validation = await validateRenderedVideo(finalMp4);
    await extractVideoThumbnail(finalMp4, firstFramePath, 0.05);
    const thumbnailSelection = await extractBestVideoThumbnail(finalMp4, thumbnailPath, candidate.duration_seconds, candidate.editorial_plan);
    await run(python, [path.join(process.cwd(), 'scripts', 'reframe_debug_overlay.py'), source, metadataPath,
      String(candidate.adjusted_start), String(candidate.adjusted_end), overlayPath, overlayCommandPath]);
    await run(python, [path.join(process.cwd(), 'scripts', 'post_render_visual_qa.py'), finalMp4, metadataPath, qaPath]);

    for (const suffix of ['ffmpeg-command.txt', 'filter-graph.txt', 'bundle.json']) {
      await copyFile(path.join(debugDir, `${id}.${suffix}`), path.join(clipDir, `${id}.production.${suffix}`));
    }
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { reframe_timeline?: Array<Record<string, unknown>>; meta?: Record<string, unknown> };
    for (const item of metadata.reframe_timeline ?? []) {
      const layout = String(item.editorialLayout ?? item.mode ?? 'UNKNOWN');
      layoutDuration[layout] = (layoutDuration[layout] ?? 0) + Math.max(0, Number(item.end) - Number(item.start));
    }
    clips.push({
      rank, start: candidate.adjusted_start, end: candidate.adjusted_end, duration: candidate.duration_seconds,
      title: candidate.title, hook: candidate.hook_text,
      supporting_transcript_quote: candidate.editorial_plan.hook_options[0].supporting_quote,
      virality_score: candidate.overall_score,
      scoring_breakdown: {
        hook_strength: candidate.hook_strength, retention_potential: candidate.retention_potential,
        story_completeness: candidate.story_completeness, entertainment_or_emotion: candidate.entertainment_or_emotion,
        educational_value: candidate.educational_value, speaker_energy: candidate.speaker_energy,
      },
      story: candidate.editorial_plan.story, conflict: candidate.editorial_plan.conflict,
      final_mp4: finalMp4, debug_overlay_mp4: overlayPath, layout_timeline_json: metadataPath,
      first_frame: firstFramePath, thumbnail: thumbnailPath, thumbnail_selection: thumbnailSelection,
      post_render_qa: qaPath, validation,
      debug_overlay_burned_into_normal_mp4: false,
    });
    console.log(`[acceptance] rendered ${rank}/8 ${candidate.title}`);
  }

  const baseline = baselinePath ? JSON.parse(await readFile(baselinePath, 'utf8')) : null;
  const manifest = {
    generated_at: new Date().toISOString(), source, transcript_path: transcriptPath,
    candidate_pool_count: pool.length, final_clip_count: selected.length,
    clips, rejected_candidates: rejected,
    semantic_overlap_matrix: semanticMatrix, timeline_overlap_matrix: timelineMatrix,
    layout_distribution_seconds: Object.fromEntries(Object.entries(layoutDuration).map(([key, value]) => [key, Number(value.toFixed(3))])),
    previous_production_comparison: baseline ? {
      previous_candidate_count: baseline.candidate_count ?? null,
      current_candidate_pool_count: pool.length,
      previous_titles: (baseline.candidates ?? []).map((item: Record<string, unknown>) => item.title),
      current_titles: selected.map((item) => item.title),
    } : null,
  };
  const manifestPath = path.join(outputDir, 'acceptance-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  await run(python, [path.join(process.cwd(), 'scripts', 'build_acceptance_contact_sheet.py'), manifestPath,
    path.join(outputDir, 'all-8-contact-sheet.jpg'), path.join(outputDir, 'filmstrips')]);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
