import { NextResponse } from 'next/server';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveProjectVideoSource } from '@/lib/source';
import { extractVideoThumbnail, renderVerticalClip, validateRenderedVideo } from '@/lib/ffmpeg';
import { segmentsToCapcutAss } from '@/lib/srt';
import { createExportSignedUrl, makeExportObjectPath, makeExportThumbnailObjectPath, uploadExportObject, uploadExportThumbnailObject } from '@/lib/storage';
import { cleanupExportTempFiles, cleanupProjectTempFiles, summarizeCleanup } from '@/lib/cleanup';
import { generateHookText } from '@/lib/hook-text';
import { getTargetClipCount } from '@/lib/clip-policy';
import { DEFAULT_CAPTION_PRESET_ID, getCaptionPresetById, type CaptionFont, type CaptionTemplate } from '@/lib/caption-presets';
import { isLikelyMockTranscript, isMockTranscriptionEnabled } from '@/lib/dev-ai';
import {
  buildDefaultClipEditSettings,
  hasClipEditSettings,
  normalizeClipEditSettings,
  phrasesToSegments,
  transcriptSegmentsToPhrases,
} from '@/lib/clip-edit';

export const maxDuration = 60;

async function maybeFinalizeProject(projectId: string) {
  const supabase = createAdminClient();

  const [
    { count: total },
    { count: done },
    { count: failed },
    { count: active },
    { data: transcriptRow },
    { count: candidateCount },
  ] = await Promise.all([
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'done').not('output_storage_path', 'is', null),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'error'),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).in('status', ['queued', 'processing']),
    supabase.from('transcripts').select('segments_json').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).single(),
    supabase.from('clip_candidates').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
  ]);

  const totalCount = Number(total ?? 0);
  const doneCount = Number(done ?? 0);
  const failedCount = Number(failed ?? 0);
  const activeCount = Number(active ?? 0);
  const transcriptSegments = Array.isArray(transcriptRow?.segments_json) ? (transcriptRow.segments_json as { end?: number }[]) : [];
  const totalSeconds = transcriptSegments.reduce((acc, s) => Math.max(acc, Number(s?.end ?? 0)), 0);
  const targetCount = Math.max(1, getTargetClipCount(totalSeconds));
  const availableCandidates = Number(candidateCount ?? 0);
  const allAttemptsSettled = totalCount > 0 && activeCount === 0 && doneCount + failedCount >= totalCount;

  if (doneCount >= targetCount && activeCount === 0) {
    await supabase
      .from('projects')
      .update({
        status: 'completed',
        pipeline_status: 'completed',
        pipeline_stage: 'completed',
        pipeline_stage_label: 'Completed',
        pipeline_progress_percent: 100,
        pipeline_error: failedCount > 0 ? 'Some exports failed, but target reel count was reached.' : null,
        pipeline_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);
    return true;
  }

  if (allAttemptsSettled && doneCount > 0) {
    await supabase
      .from('projects')
      .update({
        status: 'completed',
        pipeline_status: 'completed',
        pipeline_stage: 'completed',
        pipeline_stage_label: 'Completed',
        pipeline_progress_percent: 100,
        pipeline_error: null,
        pipeline_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);
    return true;
  }

  const candidatePoolExhausted = totalCount >= availableCandidates && availableCandidates > 0;

  if (allAttemptsSettled && candidatePoolExhausted) {
    const terminalStatus = doneCount > 0 ? 'completed' : 'error';
    await supabase
      .from('projects')
      .update({
        status: terminalStatus,
        pipeline_status: terminalStatus === 'completed' ? 'completed' : 'error',
        pipeline_error: doneCount > 0
          ? `Only ${doneCount} of ${targetCount} target reels were rendered before candidate pool was exhausted.`
          : 'All export attempts failed and no backup candidates remained.',
        pipeline_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);
    return true;
  }

  return false;
}

type JobRow = { id: string; payload: { export_id?: string } & Record<string, unknown> };

async function getProjectIdForExport(exportId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase.from('exports').select('project_id').eq('id', exportId).maybeSingle();
  return String(data?.project_id ?? '');
}

async function getProjectCompletionState(projectId: string) {
  const supabase = createAdminClient();
  const [{ data: project }, { count: savedExports }, { count: activeExports }] = await Promise.all([
    supabase
      .from('projects')
      .select('status, pipeline_status')
      .eq('id', projectId)
      .maybeSingle(),
    supabase
      .from('exports')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('status', 'done')
      .not('output_storage_path', 'is', null),
    supabase
      .from('exports')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .in('status', ['queued', 'processing']),
  ]);

  return {
    completed: project?.status === 'completed' || project?.pipeline_status === 'completed',
    hasSavedExports: Number(savedExports ?? 0) > 0,
    activeExports: Number(activeExports ?? 0),
  };
}

async function isFrozenCompletedProject(projectId: string) {
  const state = await getProjectCompletionState(projectId);
  return state.completed && state.hasSavedExports && state.activeExports === 0;
}

async function shouldSkipExportForCompletedProject(exportId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('exports')
    .select('project_id')
    .eq('id', exportId)
    .maybeSingle();

  const projectId = typeof data?.project_id === 'string' ? data.project_id : '';
  if (!projectId) return { skip: false, projectId: '' };
  return { skip: await isFrozenCompletedProject(projectId), projectId };
}

type ExportBundle = {
  id: string;
  project_id: string;
  clip_candidate_id: string;
  caption_preset_id?: string | null;
  clip_edit_settings?: Record<string, unknown> | null;
  hook_text_enabled?: boolean | null;
  hook_text?: string | null;
  project: {
    id: string;
    user_id: string;
    source_type: 'youtube' | 'upload';
    source_url?: string | null;
    source_storage_path?: string | null;
    source_duration_seconds?: number | null;
  };
  clip: {
    start_sec: number;
    end_sec: number;
    title?: string | null;
  };
  transcript: {
    segments_json: Array<{ start?: number; end?: number; text?: string; words?: Array<{ start?: number; end?: number; word?: string }> }> | null;
  } | null;
};

type ExportRenderOptions = {
  captions_enabled?: boolean;
  caption_preset_id?: string;
  caption_template?: CaptionTemplate;
  caption_font?: CaptionFont;
  hook_text_enabled?: boolean;
  hook_text?: string;
  motion_tracking?: boolean;
  auto_reframe?: boolean;
  reframe_mode?: 'off' | 'basic' | 'smart';
  reframe_preset?: 'auto' | 'tight' | 'left' | 'center' | 'right';
  edit_rerender?: boolean;
};

const EXPORT_MAX_RENDER_ATTEMPTS = 3;
const REPAIR_SCAN_LIMIT = 6;
const STALE_PROCESSING_MINUTES = 4;
const HOOK_TEXT_OVERLAY_ENABLED = process.env.ENABLE_HOOK_TEXT_OVERLAY === 'true';

function getWorkerBatchLimit() {
  const defaultLimit = process.env.VERCEL ? 1 : 2;
  const raw = Number(process.env.EXPORT_WORKER_BATCH_SIZE ?? defaultLimit);
  if (!Number.isFinite(raw)) return defaultLimit;
  return Math.max(1, Math.min(process.env.VERCEL ? 2 : 4, Math.round(raw)));
}

function normalizeReframeMode(raw: unknown, fallback: 'off' | 'basic' | 'smart'): 'off' | 'basic' | 'smart' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'basic' || value === 'smart') return value;
  return fallback;
}

function getFallbackReframeMode() {
  return normalizeReframeMode(process.env.EXPORT_FALLBACK_REFRAME_MODE, 'smart');
}

function normalizeLooseText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHookCandidate(raw: unknown) {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\-:\s]+/, '')
    .replace(/["']+$/g, '')
    .replace(/[.,;:\s]+$/g, '')
    .trim();
  return cleaned || null;
}

function isGenericHookText(text: string) {
  return /^(top moment|viral moment|best moment|clip|short|reel)$/i.test(text.trim());
}

function isTitleLikeHook(hookText: string, title: string | null | undefined) {
  const hookLoose = normalizeLooseText(hookText);
  const titleLoose = normalizeLooseText(String(title ?? ''));
  if (!hookLoose || !titleLoose) return false;
  if (hookLoose === titleLoose) return true;
  if (hookLoose.length >= 10 && titleLoose.includes(hookLoose)) return true;
  if (titleLoose.length >= 10 && hookLoose.includes(titleLoose)) return true;

  const hookWords = hookLoose.split(/\s+/).filter((word) => word.length > 2);
  const titleWords = new Set(titleLoose.split(/\s+/).filter((word) => word.length > 2));
  if (!hookWords.length || !titleWords.size) return false;
  const overlap = hookWords.filter((word) => titleWords.has(word)).length / hookWords.length;
  return hookWords.length >= 3 && overlap >= 0.8;
}

function usableHookText(raw: unknown, clipTitle: string | null | undefined) {
  const cleaned = normalizeHookCandidate(raw);
  if (!cleaned || isGenericHookText(cleaned)) return null;
  if (isTitleLikeHook(cleaned, clipTitle)) return null;
  return cleaned;
}

function buildFallbackExportPayload(exportId: string, extra: Record<string, unknown> = {}) {
  const captionPreset = getCaptionPresetById(DEFAULT_CAPTION_PRESET_ID);
  return {
    export_id: exportId,
    captions_enabled: true,
    caption_preset_id: captionPreset.id,
    caption_template: captionPreset.caption_template,
    caption_font: captionPreset.caption_font,
    hook_text_enabled: HOOK_TEXT_OVERLAY_ENABLED,
    motion_tracking: false,
    auto_reframe: true,
    reframe_mode: getFallbackReframeMode(),
    reframe_preset: 'auto',
    ...extra,
  };
}

function normalizeRenderErrorMessage(message: string) {
  if (/Upload source file could not be read|Failed to download raw media|source_storage_path|raw media/i.test(message)) {
    return 'Upload source file could not be read yet. The render was retried automatically.';
  }

  if (/Invalid NAL unit|missing picture|Error splitting the input into NAL units|Missing reference picture|mmco:|Rendered export is corrupted/i.test(message)) {
    return 'Render failed because the source video stream was corrupted or unreadable in this segment. Please retry the export.';
  }

  if (/No such filter: 'subtitles'|No such filter: 'drawtext'|Filter not found/i.test(message)) {
    return 'Render failed because this server is missing a required video filter. Please contact support.';
  }

  if (/Unknown encoder|Error while opening encoder|Encoder .* not found/i.test(message)) {
    return 'Render failed because the video encoder was unavailable on the server. Please retry.';
  }

  return 'Render failed. Please retry the export.';
}

async function validateRemoteExport(objectPath: string) {
  const signedUrl = await createExportSignedUrl(objectPath, 60 * 10);
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`Could not fetch existing export: ${res.status}`);

  const tmpDir = path.join(process.cwd(), 'tmp', 'repair-checks');
  await mkdir(tmpDir, { recursive: true });
  const localPath = path.join(tmpDir, `${objectPath.replace(/[^a-zA-Z0-9._-]+/g, '_')}.mp4`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(localPath, bytes);

  try {
    await validateRenderedVideo(localPath);
  } finally {
    await unlink(localPath).catch(() => null);
  }
}

async function enqueueRepairJob(exportId: string, projectId: string) {
  const supabase = createAdminClient();
  const { data: existingJob } = await supabase
    .from('jobs')
    .select('id')
    .eq('type', 'export')
    .in('status', ['queued', 'processing'])
    .contains('payload', { export_id: exportId })
    .maybeSingle();

  if (existingJob?.id) return false;

  const { error } = await supabase.from('jobs').insert({
    project_id: projectId,
    type: 'export',
    payload: buildFallbackExportPayload(exportId, { repair: true }),
    status: 'queued',
  });

  if (error) throw error;
  return true;
}

async function ensureQueuedExportJobs(limit = REPAIR_SCAN_LIMIT) {
  const supabase = createAdminClient();
  const { data: queuedExports, error } = await supabase
    .from('exports')
    .select('id, project_id')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;

  let created = 0;

  for (const row of queuedExports ?? []) {
    const exportId = String(row.id);
    const projectId = String(row.project_id);
    if (await isFrozenCompletedProject(projectId)) continue;

    const { data: existingJob, error: jobError } = await supabase
      .from('jobs')
      .select('id')
      .eq('type', 'export')
      .in('status', ['queued', 'processing'])
      .contains('payload', { export_id: exportId })
      .maybeSingle();

    if (jobError) throw jobError;
    if (existingJob?.id) continue;

    const { error: insertError } = await supabase.from('jobs').insert({
      project_id: projectId,
      type: 'export',
      payload: buildFallbackExportPayload(exportId, { repair: true }),
      status: 'queued',
    });

    if (insertError) throw insertError;
    created += 1;
  }

  return created;
}

async function repairBrokenCompletedExports() {
  const supabase = createAdminClient();
  const { data: rows, error } = await supabase
    .from('exports')
    .select('id, project_id, output_storage_path, error_message, updated_at')
    .eq('status', 'done')
    .not('output_storage_path', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(REPAIR_SCAN_LIMIT);

  if (error) throw error;

  let repaired = 0;

  for (const row of rows ?? []) {
    const objectPath = typeof row.output_storage_path === 'string' ? row.output_storage_path : null;
    if (!objectPath) continue;
    if (objectPath.startsWith('mock://')) {
      await supabase
        .from('exports')
        .update({
          status: 'queued',
          error_message: 'Requeued mock preview for real FFmpeg render.',
          output_storage_path: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      await enqueueRepairJob(String(row.id), String(row.project_id));
      repaired += 1;
      continue;
    }

    if (process.env.EXPORT_REPAIR_VALIDATE_DONE !== 'true') {
      continue;
    }

    try {
      await validateRemoteExport(objectPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Existing export validation failed';

      await supabase
        .from('exports')
        .update({
          status: 'queued',
          error_message: `Auto-requeued after corruption check: ${message}`,
          output_storage_path: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      await enqueueRepairJob(String(row.id), String(row.project_id));
      repaired += 1;
    }
  }

  return repaired;
}

async function requeueStaleProcessingWork() {
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60 * 1000).toISOString();

  const { data: staleJobs } = await supabase
    .from('jobs')
    .update({
      status: 'queued',
      updated_at: new Date().toISOString(),
    })
    .eq('type', 'export')
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
    .select('id');

  const { data: staleExports } = await supabase
    .from('exports')
    .update({
      status: 'queued',
      error_message: 'Requeued after render worker heartbeat expired.',
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
    .select('id');

  return {
    staleJobs: staleJobs?.length ?? 0,
    staleExports: staleExports?.length ?? 0,
  };
}

async function processExportJob(exportId: string, options?: ExportRenderOptions) {
  const supabase = createAdminClient();

  const { data: ex, error } = await supabase
    .from('exports')
    .select('id, project_id, clip_candidate_id, caption_preset_id, clip_edit_settings, hook_text_enabled, hook_text')
    .eq('id', exportId)
    .single();
  if (error || !ex) throw new Error('Export row not found');

  const [{ data: project }, { data: clip }, { data: transcript }] = await Promise.all([
    supabase
      .from('projects')
      .select('id, user_id, source_type, source_url, source_storage_path, source_duration_seconds')
      .eq('id', ex.project_id)
      .single(),
    supabase
      .from('clip_candidates')
      .select('start_sec, end_sec, title')
      .eq('id', ex.clip_candidate_id)
      .single(),
    supabase
      .from('transcripts')
      .select('segments_json')
      .eq('project_id', ex.project_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
  ]);

  if (!project || !clip) throw new Error('Missing project/clip data');

  const bundle: ExportBundle = {
    id: String(ex.id),
    project_id: String(ex.project_id),
    clip_candidate_id: String(ex.clip_candidate_id),
    caption_preset_id: typeof ex.caption_preset_id === 'string' ? ex.caption_preset_id : null,
    clip_edit_settings: typeof ex.clip_edit_settings === 'object' && ex.clip_edit_settings ? ex.clip_edit_settings as Record<string, unknown> : null,
    hook_text_enabled: ex.hook_text_enabled !== false,
    hook_text: typeof ex.hook_text === 'string' ? ex.hook_text : null,
    project: {
      id: String(project.id),
      user_id: String(project.user_id),
      source_type: project.source_type as 'youtube' | 'upload',
      source_url: (project.source_url as string | null) ?? null,
      source_storage_path: (project.source_storage_path as string | null) ?? null,
      source_duration_seconds: Number(project.source_duration_seconds ?? 0),
    },
    clip: {
      start_sec: Number(clip.start_sec),
      end_sec: Number(clip.end_sec),
      title: typeof clip.title === 'string' ? clip.title : null,
    },
    transcript: transcript
      ? {
          segments_json: (transcript.segments_json as Array<{ start?: number; end?: number; text?: string; words?: Array<{ start?: number; end?: number; word?: string }> }> | null) ?? null,
        }
      : null,
  };

  const inputPath = await resolveProjectVideoSource(bundle.project);

  const exportDir = path.join(process.cwd(), 'tmp', 'exports', bundle.project_id);
  await mkdir(exportDir, { recursive: true });
  const outPath = path.join(exportDir, `${bundle.id}.mp4`);

  const srtPath = path.join(exportDir, `${bundle.id}.ass`);
  const transcriptSegments = bundle.transcript?.segments_json ?? [];

  if (!isMockTranscriptionEnabled() && isLikelyMockTranscript(transcriptSegments)) {
    throw new Error('This export is using a mock transcript. Start a new project after disabling mock AI so captions can match the real audio.');
  }

  const transcriptPhrases = transcriptSegmentsToPhrases(transcriptSegments);
  const transcriptDuration = transcriptSegments.reduce((max, seg) => Math.max(max, Number(seg.end ?? 0)), 0);
  const sourceDuration = Math.max(
    Number(bundle.project.source_duration_seconds ?? 0),
    transcriptDuration,
    Number(bundle.clip.end_sec ?? 0),
  );
  const defaults = buildDefaultClipEditSettings({
    aiStart: bundle.clip.start_sec,
    aiEnd: bundle.clip.end_sec,
    sourceDuration,
    transcriptPhrases,
    captionPresetId: bundle.caption_preset_id,
  });
  const useEditSettings = options?.edit_rerender === true || hasClipEditSettings(bundle.clip_edit_settings);
  const editSettings = normalizeClipEditSettings(bundle.clip_edit_settings, defaults, sourceDuration);
  const renderStart = useEditSettings ? editSettings.clip_start_seconds : bundle.clip.start_sec;
  const renderEnd = useEditSettings ? editSettings.clip_end_seconds : bundle.clip.end_sec;
  const captionPreset = getCaptionPresetById(
    useEditSettings
      ? editSettings.caption_preset_id
      : options?.caption_preset_id ?? bundle.caption_preset_id ?? DEFAULT_CAPTION_PRESET_ID,
  );
  const captionTemplate: CaptionTemplate = options?.caption_template ?? captionPreset.caption_template;
  const captionFont: CaptionFont = options?.caption_font ?? captionPreset.caption_font;
  const renderTranscriptSegments = useEditSettings ? phrasesToSegments(editSettings.edited_transcript) : transcriptSegments;
  const captionStyle = useEditSettings
    ? {
        ...captionPreset,
        captionFontSize: editSettings.caption_font_size,
        captionTextColor: editSettings.caption_text_color,
        captionHighlightColor: editSettings.caption_highlight_color,
        captionPosition: editSettings.caption_position,
        captionBackgroundBox: editSettings.caption_background,
        captionWordHighlight: editSettings.caption_word_highlight,
        captionMaxWords: editSettings.caption_max_words,
      }
    : {
        ...captionPreset,
        caption_template: captionTemplate,
      };

  const captionText = segmentsToCapcutAss(renderTranscriptSegments, renderStart, renderEnd, captionStyle);

  const fallbackCaption = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial Black,127,&H00FFFFFF,&H005AF421,&H00000000,&H00000000,-1,0,0,0,106,110,0,0,1,12,2,2,40,40,380,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.50,Default,,0,0,0,,\n';
  await writeFile(srtPath, captionText || fallbackCaption);

  const generatedHookText = generateHookText({
    clipTitle: bundle.clip.title ?? null,
    transcriptSegments,
    startSec: renderStart,
    endSec: renderEnd,
  });
  const hookTextEnabled = HOOK_TEXT_OVERLAY_ENABLED && bundle.hook_text_enabled !== false && options?.hook_text_enabled !== false;
  const hookText = usableHookText(options?.hook_text, bundle.clip.title)
    || usableHookText(bundle.hook_text, bundle.clip.title)
    || normalizeHookCandidate(generatedHookText)
    || null;

  await renderVerticalClip({
    inputPath,
    outputPath: outPath,
    startSec: renderStart,
    endSec: renderEnd,
    srtPath,
    captionsEnabled: useEditSettings ? editSettings.captions_enabled : options?.captions_enabled !== false,
    captionTemplate,
    captionFont,
    hookTextEnabled,
    hookText,
    motionTracking: options?.motion_tracking === true,
    autoReframe: useEditSettings ? editSettings.framing_mode === 'auto' : options?.auto_reframe !== false,
    reframeMode: options?.reframe_mode ?? getFallbackReframeMode(),
    reframePreset: options?.reframe_preset ?? 'auto',
    framingMode: useEditSettings ? editSettings.framing_mode : 'auto',
    cropX: useEditSettings ? editSettings.crop_x : undefined,
    cropY: useEditSettings ? editSettings.crop_y : undefined,
    zoom: useEditSettings ? editSettings.zoom : undefined,
    debugClipId: bundle.id,
    debugCandidateId: bundle.clip_candidate_id,
  });

  await validateRenderedVideo(outPath);

  const bytes = await readFile(outPath);
  const objectPath = makeExportObjectPath(bundle.project.user_id, bundle.project_id, bundle.id);
  await uploadExportObject(objectPath, bytes);

  try {
    const posterPath = path.join(exportDir, `${bundle.id}.jpg`);
    const clipDuration = Math.max(0.25, renderEnd - renderStart);
    const posterSecond = Math.min(1.5, Math.max(0.25, clipDuration * 0.18));
    await extractVideoThumbnail(outPath, posterPath, posterSecond);
    const posterBytes = await readFile(posterPath);
    const posterObjectPath = makeExportThumbnailObjectPath(bundle.project.user_id, bundle.project_id, bundle.id);
    await uploadExportThumbnailObject(posterObjectPath, posterBytes);
  } catch (thumbnailError) {
    console.warn('[jobs/process] export-thumbnail-failed', {
      export_id: bundle.id,
      error: thumbnailError instanceof Error ? thumbnailError.message : 'Unknown thumbnail error',
    });
  }

  const { error: e1 } = await supabase
    .from('exports')
    .update({
      status: 'done',
      output_storage_path: objectPath,
      error_message: null,
      edit_status: useEditSettings ? 'rendered' : 'idle',
      updated_at: new Date().toISOString(),
    })
    .eq('id', bundle.id);
  if (e1) throw e1;
}

export async function POST() {
  const supabase = createAdminClient();
  const stale = await requeueStaleProcessingWork().catch((error) => {
    console.warn('[jobs/process] stale requeue failed', error);
    return { staleJobs: 0, staleExports: 0 };
  });
  const repaired = await repairBrokenCompletedExports().catch((error) => {
    console.warn('[jobs/process] repair scan failed', error);
    return 0;
  });
  const ensuredQueuedJobs = await ensureQueuedExportJobs().catch((error) => {
    console.warn('[jobs/process] queued export job repair failed', error);
    return 0;
  });
  const batchLimit = getWorkerBatchLimit();

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, payload')
    .eq('status', 'queued')
    .eq('type', 'export')
    .order('created_at', { ascending: true })
    .limit(batchLimit);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  let workItems: Array<{ jobId: string | null; exportId: string | null; payload: Record<string, unknown> }> =
    ((jobs ?? []) as JobRow[]).map((job) => ({
      jobId: job.id,
      exportId: job.payload?.export_id ?? null,
      payload: (job.payload as Record<string, unknown>) ?? {},
    }));

  const queuedExportSlots = Math.max(0, batchLimit - workItems.length);
  if (queuedExportSlots > 0) {
    const alreadySelectedExportIds = new Set(
      workItems
        .map((item) => item.exportId)
        .filter((id): id is string => Boolean(id)),
    );
    const { data: queuedExports, error: exErr } = await supabase
      .from('exports')
      .select('id, project_id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(batchLimit * 2);

    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 400 });

    for (const row of queuedExports ?? []) {
      const exportId = String(row.id);
      if (alreadySelectedExportIds.has(exportId)) continue;
      if (await isFrozenCompletedProject(String(row.project_id))) continue;

      workItems.push({
        jobId: null,
        exportId,
        payload: buildFallbackExportPayload(exportId, { recovered_missing_job: true }),
      });
      alreadySelectedExportIds.add(exportId);
      if (workItems.length >= batchLimit) break;
    }
  }

  console.log('[jobs/process] queue snapshot', {
    queued_jobs_fetched: (jobs ?? []).length,
    work_items_selected: workItems.length,
    repaired_done_exports: repaired,
    stale_jobs_requeued: stale.staleJobs,
    stale_exports_requeued: stale.staleExports,
    ensured_queued_jobs: ensuredQueuedJobs,
    batch_limit: batchLimit,
  });

  if (!workItems.length) return NextResponse.json({ ok: true, processed: 0, counts: { queued_jobs_fetched: 0, work_items_selected: 0 } });

  let processed = 0;
  for (const item of workItems) {
    try {
      let attemptNumber = 1;

      if (item.jobId) {
        const { data: jobRow } = await supabase
          .from('jobs')
          .select('attempts')
          .eq('id', item.jobId)
          .maybeSingle();

        const previousAttempts = Number(jobRow?.attempts ?? 0);
        attemptNumber = previousAttempts + 1;

        const { data: claimedJob } = await supabase
          .from('jobs')
          .update({ status: 'processing', attempts: attemptNumber, updated_at: new Date().toISOString() })
          .eq('id', item.jobId)
          .eq('status', 'queued')
          .select('id')
          .maybeSingle();

        if (!claimedJob?.id) continue;
      }

      const exportId = item.exportId;
      if (!exportId) throw new Error('Missing export_id in payload');
      const isEditRerender = item.payload?.edit_rerender === true;

      const completedGate = isEditRerender ? { skip: false, projectId: '' } : await shouldSkipExportForCompletedProject(exportId);
      if (completedGate.skip) {
        await supabase
          .from('exports')
          .update({
            status: 'error',
            error_message: 'Skipped because this project is already completed.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', exportId)
          .in('status', ['queued', 'processing']);

        if (item.jobId) {
          await supabase
            .from('jobs')
            .update({
              status: 'done',
              updated_at: new Date().toISOString(),
              payload: { ...item.payload, skipped: 'project_completed' },
            })
            .eq('id', item.jobId);
        }
        continue;
      }

      const { data: claimedExport } = isEditRerender
        ? await supabase
            .from('exports')
            .update({ edit_status: 'rendering', error_message: null, updated_at: new Date().toISOString() })
            .eq('id', exportId)
            .select('id')
            .maybeSingle()
        : await supabase
            .from('exports')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('id', exportId)
            .eq('status', 'queued')
            .select('id')
            .maybeSingle();

      if (!claimedExport?.id) {
        if (item.jobId) {
          await supabase
            .from('jobs')
            .update({ status: 'done', updated_at: new Date().toISOString(), payload: { ...item.payload, skipped: 'export_not_queued' } })
            .eq('id', item.jobId);
        }
        continue;
      }

      await processExportJob(exportId, {
        captions_enabled: item.payload?.captions_enabled as boolean | undefined,
        caption_preset_id: item.payload?.caption_preset_id as string | undefined,
        caption_template: item.payload?.caption_template as
          | 'clean'
          | 'bold'
          | 'viral'
          | 'karaoke'
          | 'cinematic'
          | 'rage'
          | 'minimal'
          | 'capcut'
          | undefined,
        caption_font: item.payload?.caption_font as
          | 'arial'
          | 'montserrat'
          | 'impact'
          | 'bangers'
          | 'anton'
          | 'bebas'
          | 'poppins'
          | undefined,
        hook_text_enabled: item.payload?.hook_text_enabled as boolean | undefined,
        hook_text: item.payload?.hook_text as string | undefined,
        motion_tracking: item.payload?.motion_tracking as boolean | undefined,
        auto_reframe: item.payload?.auto_reframe as boolean | undefined,
        reframe_mode: item.payload?.reframe_mode as 'off' | 'basic' | 'smart' | undefined,
        reframe_preset: item.payload?.reframe_preset as 'auto' | 'tight' | 'left' | 'center' | 'right' | undefined,
        edit_rerender: isEditRerender,
      });

      if (item.jobId) {
        await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', item.jobId);
      }
      const projectId = await getProjectIdForExport(exportId);
      const exportCleanupLog = await cleanupExportTempFiles(projectId, exportId);
      console.log('[cleanup] export-temp-files', { project_id: projectId, export_id: exportId, status: 'completed', ...summarizeCleanup(exportCleanupLog) });
      if (!isEditRerender) {
        const terminal = await maybeFinalizeProject(projectId);
        if (terminal) {
          const cleanupLog = await cleanupProjectTempFiles(projectId);
          console.log('[cleanup] project-temp-files', { project_id: projectId, status: 'terminal', ...summarizeCleanup(cleanupLog) });
        }
      }
      processed += 1;
    } catch (e: unknown) {
      const rawMessage = e instanceof Error ? e.message : 'Job failed';
      console.error('[jobs/process] export-failed', {
        export_id: item.exportId,
        job_id: item.jobId,
        raw_error: rawMessage,
        payload: item.payload,
      });
      const exportId = item.exportId;
      const isEditRerender = item.payload?.edit_rerender === true;
      const message = isEditRerender ? rawMessage : normalizeRenderErrorMessage(rawMessage);

      let currentAttempts = 1;
      if (item.jobId) {
        const { data: jobRow } = await supabase
          .from('jobs')
          .select('attempts')
          .eq('id', item.jobId)
          .maybeSingle();
        currentAttempts = Number(jobRow?.attempts ?? 1);
      }

      const shouldRetry = Boolean(item.jobId && exportId && currentAttempts < EXPORT_MAX_RENDER_ATTEMPTS);

      if (shouldRetry && item.jobId) {
        await supabase
          .from('jobs')
          .update({
            status: 'queued',
            updated_at: new Date().toISOString(),
            payload: { ...item.payload, retry_of_error: message, repair: item.payload?.repair === true },
          })
          .eq('id', item.jobId);

        if (exportId) {
          if (isEditRerender) {
            await supabase
              .from('exports')
              .update({
                edit_status: 'rendering',
                error_message: `Retrying clip update (${currentAttempts}/${EXPORT_MAX_RENDER_ATTEMPTS}): ${message}`,
                updated_at: new Date().toISOString(),
              })
              .eq('id', exportId);
          } else {
            await supabase
              .from('exports')
              .update({
                status: 'queued',
                error_message: `Retrying render (${currentAttempts}/${EXPORT_MAX_RENDER_ATTEMPTS}): ${message}`,
                updated_at: new Date().toISOString(),
              })
              .eq('id', exportId);
          }
        }

        continue;
      }

      if (item.jobId) {
        await supabase
          .from('jobs')
          .update({ status: 'error', updated_at: new Date().toISOString(), payload: { ...item.payload, error: message } })
          .eq('id', item.jobId);
      }

      if (exportId) {
        await supabase
          .from('exports')
          .update(isEditRerender
            ? { edit_status: 'error', error_message: message, updated_at: new Date().toISOString() }
            : { status: 'error', error_message: message, updated_at: new Date().toISOString() })
          .eq('id', exportId);
        const projectId = await getProjectIdForExport(exportId);
        const exportCleanupLog = await cleanupExportTempFiles(projectId, exportId);
        console.log('[cleanup] export-temp-files', { project_id: projectId, export_id: exportId, status: 'failed', ...summarizeCleanup(exportCleanupLog) });

        if (!isEditRerender) {
          try {
            const refillRes = await fetch(`${process.env.APP_URL || 'http://127.0.0.1:3000'}/api/clips/export`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ project_id: projectId }),
              cache: 'no-store',
            });
            const refillData = await refillRes.json().catch(() => ({}));
            console.log('[jobs/process] refill-attempt', { project_id: projectId, export_id: exportId, refillData, status: refillRes.status });
          } catch (refillError) {
            console.warn('[jobs/process] refill-failed', { project_id: projectId, export_id: exportId, refillError });
          }

          const terminal = await maybeFinalizeProject(projectId);
          if (terminal) {
            const cleanupLog = await cleanupProjectTempFiles(projectId);
            console.log('[cleanup] project-temp-files', { project_id: projectId, status: 'terminal', ...summarizeCleanup(cleanupLog) });
          }
        }
      }
    }
  }

  console.log('[jobs/process] results', {
    work_items_selected: workItems.length,
    processed,
  });

  return NextResponse.json({ ok: true, processed, repaired, ensuredQueuedJobs, counts: { work_items_selected: workItems.length, processed, repaired, ensured_queued_jobs: ensuredQueuedJobs } });
}
