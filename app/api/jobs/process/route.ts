import { NextResponse } from 'next/server';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveProjectVideoSource } from '@/lib/source';
import { extractBestVideoThumbnail, renderCutVideo, renderVerticalClip, validateRenderedVideo } from '@/lib/ffmpeg';
import { segmentsToCapcutAss } from '@/lib/srt';
import { createExportSignedUrl, makeExportObjectPath, makeExportThumbnailObjectPath, uploadExportObject, uploadExportThumbnailObject } from '@/lib/storage';
import { cleanupExportTempFiles, cleanupProjectTempFiles, summarizeCleanup } from '@/lib/cleanup';
import { generateHookText } from '@/lib/hook-text';
import { getTargetClipCount } from '@/lib/clip-policy';
import { DEFAULT_CAPTION_PRESET_ID, getCaptionPresetById, type CaptionFont, type CaptionTemplate } from '@/lib/caption-presets';
import { isLikelyMockTranscript, isMockTranscriptionEnabled } from '@/lib/dev-ai';
import { hasSettledSuccessfulExports } from '@/lib/project-completion';
import {
  buildDefaultClipEditSettings,
  hasClipEditSettings,
  normalizeClipEditSettings,
  phrasesToSegments,
  type TranscriptPhrase,
  transcriptSegmentsToPhrases,
} from '@/lib/clip-edit';

export const maxDuration = 300;

async function maybeFinalizeProject(projectId: string) {
  const supabase = createAdminClient();

  const [
    { count: total },
    { count: done },
    { count: failed },
    { count: active },
    { data: transcriptRow },
    { count: candidateCount },
    { count: activeJobs },
  ] = await Promise.all([
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).not('output_storage_path', 'is', null).neq('status', 'error'),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'error'),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).in('status', ['queued', 'processing']).is('output_storage_path', null),
    supabase.from('transcripts').select('segments_json').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).single(),
    supabase.from('clip_candidates').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
    supabase.from('jobs').select('*', { count: 'exact', head: true }).eq('project_id', projectId).in('type', ['pipeline', 'export']).in('status', ['queued', 'processing']),
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
  const allCreatedExportsSucceeded = hasSettledSuccessfulExports({
    totalExports: totalCount,
    doneExports: doneCount,
    failedExports: failedCount,
    activeExports: activeCount,
    activeJobs: Number(activeJobs ?? 0),
  });

  if ((doneCount >= targetCount && activeCount === 0) || allCreatedExportsSucceeded) {
    await supabase
      .from('projects')
      .update({
        status: 'exported',
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
    if (doneCount > 0 && failedCount === 0) {
      await supabase
        .from('projects')
        .update({
          status: 'exported',
          pipeline_status: 'completed',
          pipeline_stage: 'completed',
          pipeline_stage_label: 'Completed',
          pipeline_progress_percent: 100,
          pipeline_error: null,
          pipeline_completed_at: new Date().toISOString(),
          worker_last_seen_at: new Date().toISOString(),
          worker_last_log_message: `Completed with ${doneCount} playable reels and no failed exports`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', projectId);
      return true;
    }

    await supabase
      .from('projects')
      .update({
        status: 'error',
        pipeline_status: 'error',
        pipeline_stage: 'error',
        pipeline_stage_label: 'Could not finish every reel',
        pipeline_progress_percent: Math.min(98, Math.round((doneCount / targetCount) * 100)),
        pipeline_error: failedCount > 0
          ? `${failedCount} reel${failedCount === 1 ? '' : 's'} could not be rendered after all automatic compatibility fallbacks.`
          : 'All export attempts failed and no backup candidates remained.',
        pipeline_completed_at: null,
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

function hasPlayableOutput(row: { status?: string | null; output_storage_path?: string | null }) {
  return row.status !== 'error'
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://');
}

function isTranscriptPhraseRow(value: unknown): value is TranscriptPhrase {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<TranscriptPhrase>;
  return typeof row.id === 'string'
    && Number.isFinite(Number(row.start))
    && Number.isFinite(Number(row.end))
    && Number(row.end) > Number(row.start)
    && typeof row.text === 'string'
    && typeof row.originalText === 'string';
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
      .not('output_storage_path', 'is', null)
      .neq('status', 'error'),
    supabase
      .from('exports')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .in('status', ['queued', 'processing'])
      .is('output_storage_path', null),
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
    editorial_plan?: Record<string, unknown> | null;
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
  fast_edit_render?: boolean;
  safe_layout_fallback?: boolean;
  compatibility_fallback?: boolean;
};

type ExportLookupRow = {
  id: unknown;
  project_id: unknown;
  clip_candidate_id: unknown;
  caption_preset_id?: unknown;
  clip_edit_settings?: unknown;
  hook_text_enabled?: unknown;
  hook_text?: unknown;
};

const TRANSIENT_RENDER_ATTEMPTS = 2;
const REPAIR_SCAN_LIMIT = 6;
const STALE_PROCESSING_MINUTES = 4;
const EXPORT_HEARTBEAT_INTERVAL_MS = 20_000;
const HOOK_TEXT_OVERLAY_ENABLED = process.env.ENABLE_HOOK_TEXT_OVERLAY !== 'false';

function getWorkerBatchLimit() {
  // One claim per worker keeps every claimed render actively heartbeating.
  // Run two worker processes for two-way concurrency instead of letting one
  // request claim a second export that sits idle behind its first FFmpeg job.
  return 1;
}

function startExportHeartbeat(params: {
  supabase: ReturnType<typeof createAdminClient>;
  projectId: string;
  exportId: string;
  jobId: string | null;
}) {
  const { supabase, projectId, exportId, jobId } = params;
  let stopped = false;
  let heartbeatInFlight: Promise<void> = Promise.resolve();

  const touch = async () => {
    if (stopped) return;
    const now = new Date().toISOString();
    const updates = [
      supabase
        .from('projects')
        .update({
          pipeline_status: 'processing',
          pipeline_stage: 'rendering',
          pipeline_stage_label: 'Rendering reels',
          pipeline_error: null,
          worker_last_seen_at: now,
          worker_last_log_message: `Rendering export ${exportId}`,
        })
        .eq('id', projectId),
      supabase
        .from('exports')
        .update({ updated_at: now })
        .eq('id', exportId)
        .eq('status', 'processing'),
    ];

    if (jobId) {
      updates.push(
        supabase
          .from('jobs')
          .update({ updated_at: now })
          .eq('id', jobId)
          .eq('status', 'processing'),
      );
    }

    const results = await Promise.all(updates);
    const firstError = results.find((result) => result.error)?.error;
    if (firstError) {
      console.warn('[jobs/process] render heartbeat failed', {
        project_id: projectId,
        export_id: exportId,
        error: firstError.message,
      });
    }
  };

  const scheduleTouch = () => {
    heartbeatInFlight = heartbeatInFlight
      .then(touch)
      .catch((error) => {
        console.warn('[jobs/process] render heartbeat threw', {
          project_id: projectId,
          export_id: exportId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  scheduleTouch();
  const timer = setInterval(scheduleTouch, EXPORT_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await heartbeatInFlight;
  };
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return [
      record.message,
      record.details,
      record.hint,
      record.code,
      JSON.stringify(record),
    ].filter(Boolean).join(' ');
  }
  return String(error);
}

function isMissingEditColumnError(error: unknown) {
  const text = errorText(error);
  return /(clip_edit_settings|edit_status)/i.test(text)
    && /(column|schema cache|could not find|PGRST204|42703)/i.test(text);
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
    return 'The source video stream was unreadable in this segment.';
  }

  if (/No such filter: 'subtitles'|No such filter: 'drawtext'|Filter not found/i.test(message)) {
    return 'A required video filter was unavailable on the render worker.';
  }

  if (/Unknown encoder|Error while opening encoder|Encoder .* not found/i.test(message)) {
    return 'The video encoder was unavailable on the render worker.';
  }

  return 'The render worker could not finish this reel.';
}

function renderFailureDiagnostics(message: string) {
  const category =
    /crop=.*(?:negative|invalid)|Invalid too big or non positive size|crop area/i.test(message) ? 'invalid_crop_coordinates' :
    /filter|filtergraph|subtitles|drawtext/i.test(message) ? 'ffmpeg_filter_graph' :
    /No such file|could not be read|download raw media|source_storage_path/i.test(message) ? 'missing_or_unreadable_input' :
    /python|mediapipe|detector|reframe_per_clip/i.test(message) ? 'python_detector' :
    /timeout|timed out|SIGTERM/i.test(message) ? 'timeout' :
    /out of memory|ENOMEM|Cannot allocate memory|killed/i.test(message) ? 'memory_or_resource_failure' :
    /upload|storage|R2|Supabase/i.test(message) ? 'upload_or_storage_failure' :
    /encoder|ffmpeg|Invalid NAL|missing picture/i.test(message) ? 'ffmpeg_render' :
    'unknown';
  const stderrTail = message.split(/\r?\n/).slice(-80).join('\n').slice(-8000);
  return { category, stderrTail };
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

async function recoverTerminalRenderErrors(limit = REPAIR_SCAN_LIMIT) {
  const supabase = createAdminClient();
  const { data: failedJobs, error } = await supabase
    .from('jobs')
    .select('id, project_id, payload, updated_at')
    .eq('type', 'export')
    .eq('status', 'error')
    .order('updated_at', { ascending: false })
    .limit(Math.max(50, limit * 10));

  if (error) throw error;

  let recovered = 0;

  for (const row of failedJobs ?? []) {
    if (recovered >= limit) break;
    const payload = row.payload && typeof row.payload === 'object'
      ? row.payload as Record<string, unknown>
      : {};
    const exportId = typeof payload.export_id === 'string' ? payload.export_id : '';
    const projectId = String(row.project_id ?? '');
    if (!exportId || !projectId) continue;
    if (payload.edit_rerender === true || payload.compatibility_fallback === true) continue;
    if (['missing_or_unreadable_input', 'upload_or_storage_failure'].includes(String(payload.render_failure_category ?? ''))) continue;
    if (await isFrozenCompletedProject(projectId)) continue;

    const { data: exportRow, error: exportError } = await supabase
      .from('exports')
      .select('status, output_storage_path')
      .eq('id', exportId)
      .maybeSingle();
    if (exportError) throw exportError;
    if (!exportRow || hasPlayableOutput(exportRow) || exportRow.status !== 'error') continue;

    const now = new Date().toISOString();
    const recoveryPayload = {
      ...payload,
      safe_layout_fallback: true,
      compatibility_fallback: true,
      automatic_recovery: true,
      recovered_at: now,
    };

    const [{ error: jobUpdateError }, { error: exportUpdateError }, { error: projectUpdateError }] = await Promise.all([
      supabase
        .from('jobs')
        .update({ status: 'queued', attempts: 0, payload: recoveryPayload, updated_at: now })
        .eq('id', row.id),
      supabase
        .from('exports')
        .update({
          status: 'queued',
          output_storage_path: null,
          error_message: 'Automatically recovering this reel with a compatible render.',
          updated_at: now,
        })
        .eq('id', exportId),
      supabase
        .from('projects')
        .update({
          status: 'analyzed',
          pipeline_status: 'processing',
          pipeline_stage: 'rendering',
          pipeline_stage_label: 'Rendering reels',
          pipeline_error: null,
          pipeline_completed_at: null,
          worker_last_log_message: `Automatically recovering export ${exportId}`,
          updated_at: now,
        })
        .eq('id', projectId),
    ]);

    const updateError = jobUpdateError || exportUpdateError || projectUpdateError;
    if (updateError) throw updateError;
    recovered += 1;
    console.warn('[jobs/process] terminal-export-auto-recovered', {
      project_id: projectId,
      export_id: exportId,
      job_id: row.id,
    });
  }

  return recovered;
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

  await supabase
    .from('exports')
    .update({
      status: 'done',
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .not('output_storage_path', 'is', null)
    .lt('updated_at', cutoff);

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
    .is('output_storage_path', null)
    .lt('updated_at', cutoff)
    .select('id');

  return {
    staleJobs: staleJobs?.length ?? 0,
    staleExports: staleExports?.length ?? 0,
  };
}

async function processExportJob(exportId: string, options?: ExportRenderOptions) {
  const supabase = createAdminClient();

  const exportLookup = await supabase
    .from('exports')
    .select('id, project_id, clip_candidate_id, caption_preset_id, clip_edit_settings, hook_text_enabled, hook_text')
    .eq('id', exportId)
    .single();

  let ex = exportLookup.data as ExportLookupRow | null;
  let error = exportLookup.error;

  if (error && isMissingEditColumnError(error)) {
    console.warn('[jobs/process] edit columns missing; rendering export with legacy exports schema', { export_id: exportId });
    const fallbackLookup = await supabase
      .from('exports')
      .select('id, project_id, clip_candidate_id, caption_preset_id, hook_text_enabled, hook_text')
      .eq('id', exportId)
      .single();
    ex = fallbackLookup.data ? { ...(fallbackLookup.data as ExportLookupRow), clip_edit_settings: null } : null;
    error = fallbackLookup.error;
  }

  if (error || !ex) throw new Error('Export row not found');
  const exportProjectId = String(ex.project_id ?? '');
  const exportCandidateId = String(ex.clip_candidate_id ?? '');
  if (!exportProjectId || !exportCandidateId) throw new Error('Export row is missing project or clip candidate data');

  const [{ data: project }, { data: clip }, { data: transcript }] = await Promise.all([
    supabase
      .from('projects')
      .select('id, user_id, source_type, source_url, source_storage_path, source_duration_seconds')
      .eq('id', exportProjectId)
      .single(),
    supabase
      .from('clip_candidates')
      .select('*')
      .eq('id', exportCandidateId)
      .single(),
    supabase
      .from('transcripts')
      .select('segments_json')
      .eq('project_id', exportProjectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
  ]);

  if (!project || !clip) throw new Error('Missing project/clip data');

  const bundle: ExportBundle = {
    id: String(ex.id),
    project_id: exportProjectId,
    clip_candidate_id: exportCandidateId,
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
      editorial_plan: typeof clip.editorial_plan === 'object' && clip.editorial_plan
        ? clip.editorial_plan as Record<string, unknown>
        : null,
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
  let renderInputPath = inputPath;
  let effectiveRenderStart = renderStart;
  let effectiveRenderEnd = renderEnd;
  const captionPreset = getCaptionPresetById(
    useEditSettings
      ? editSettings.caption_preset_id
      : options?.caption_preset_id ?? bundle.caption_preset_id ?? DEFAULT_CAPTION_PRESET_ID,
  );
  const captionTemplate: CaptionTemplate = options?.caption_template ?? captionPreset.caption_template;
  const captionFont: CaptionFont = options?.caption_font ?? captionPreset.caption_font;
  const editedTranscriptPhrases = Array.isArray(editSettings.edited_transcript)
    ? editSettings.edited_transcript.filter(isTranscriptPhraseRow)
    : [];
  let renderTranscriptSegments = useEditSettings ? phrasesToSegments(editedTranscriptPhrases) : transcriptSegments;

  if (useEditSettings && editSettings.removed_ranges.length) {
    const removed = editSettings.removed_ranges
      .map((range) => ({
        start: Math.max(renderStart, Math.min(renderEnd, range.start)),
        end: Math.max(renderStart, Math.min(renderEnd, range.end)),
      }))
      .filter((range) => range.end - range.start >= 0.15)
      .sort((a, b) => a.start - b.start);
    const kept: Array<{ start: number; end: number }> = [];
    let cursor = renderStart;
    for (const range of removed) {
      if (range.start > cursor + 0.05) kept.push({ start: cursor, end: range.start });
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < renderEnd - 0.05) kept.push({ start: cursor, end: renderEnd });
    if (!kept.length) throw new Error('The selected cuts remove the entire clip');

    const cutPath = path.join(exportDir, `${bundle.id}.cut.mp4`);
    await renderCutVideo(inputPath, cutPath, kept);
    renderInputPath = cutPath;
    effectiveRenderStart = 0;
    effectiveRenderEnd = kept.reduce((total, range) => total + (range.end - range.start), 0);
    renderTranscriptSegments = renderTranscriptSegments.flatMap((segment) => {
      const segmentStart = Number(segment.start ?? 0);
      const segmentEnd = Number(segment.end ?? segmentStart);
      let elapsed = 0;
      const mapped: typeof renderTranscriptSegments = [];
      for (const range of kept) {
        const overlapStart = Math.max(segmentStart, range.start);
        const overlapEnd = Math.min(segmentEnd, range.end);
        if (overlapEnd > overlapStart) {
          mapped.push({
            ...segment,
            start: elapsed + (overlapStart - range.start),
            end: elapsed + (overlapEnd - range.start),
            words: [],
          });
        }
        elapsed += range.end - range.start;
      }
      return mapped;
    });
  }
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

  const captionText = segmentsToCapcutAss(renderTranscriptSegments, effectiveRenderStart, effectiveRenderEnd, captionStyle);

  const fallbackCaption = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial Black,146,&H00FFFFFF,&H005AF421,&H00000000,&H00000000,-1,0,0,0,106,110,0,0,1,12,2,2,40,40,380,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.50,Default,,0,0,0,,\n';
  await writeFile(srtPath, captionText || fallbackCaption);

  const generatedHookText = generateHookText({
    clipTitle: bundle.clip.title ?? null,
    transcriptSegments: renderTranscriptSegments,
    startSec: effectiveRenderStart,
    endSec: effectiveRenderEnd,
  });
  const compatibilityFallback = options?.compatibility_fallback === true;
  const hookTextEnabled = !compatibilityFallback
    && HOOK_TEXT_OVERLAY_ENABLED
    && bundle.hook_text_enabled !== false
    && options?.hook_text_enabled !== false;
  const hookText = usableHookText(options?.hook_text, bundle.clip.title)
    || usableHookText(bundle.hook_text, bundle.clip.title)
    || normalizeHookCandidate(generatedHookText)
    || null;
  const safeLayoutFallback = options?.safe_layout_fallback === true || compatibilityFallback;

  await renderVerticalClip({
    inputPath: renderInputPath,
    outputPath: outPath,
    startSec: effectiveRenderStart,
    endSec: effectiveRenderEnd,
    srtPath,
    captionsEnabled: compatibilityFallback
      ? false
      : useEditSettings
        ? editSettings.captions_enabled
        : options?.captions_enabled !== false,
    captionTemplate,
    captionFont,
    hookTextEnabled,
    hookText,
    motionTracking: options?.motion_tracking === true,
    autoReframe: safeLayoutFallback ? false : useEditSettings ? editSettings.framing_mode === 'auto' : options?.auto_reframe !== false,
    reframeMode: safeLayoutFallback ? 'off' : options?.reframe_mode ?? getFallbackReframeMode(),
    reframePreset: options?.reframe_preset ?? 'auto',
    framingMode: safeLayoutFallback ? 'fit' : useEditSettings ? editSettings.framing_mode : 'auto',
    cropX: useEditSettings ? editSettings.crop_x : undefined,
    cropY: useEditSettings ? editSettings.crop_y : undefined,
    zoom: useEditSettings ? editSettings.zoom : undefined,
    debugClipId: bundle.id,
    debugCandidateId: bundle.clip_candidate_id,
    editorialPlan: bundle.clip.editorial_plan,
    fastRender: options?.fast_edit_render === true,
  });

  await validateRenderedVideo(outPath);

  const bytes = await readFile(outPath);
  const objectPath = makeExportObjectPath(bundle.project.user_id, bundle.project_id, bundle.id);
  await uploadExportObject(objectPath, bytes);

  try {
    const posterPath = path.join(exportDir, `${bundle.id}.jpg`);
    const clipDuration = Math.max(0.25, effectiveRenderEnd - effectiveRenderStart);
    const thumbnailSelection = await extractBestVideoThumbnail(outPath, posterPath, clipDuration, bundle.clip.editorial_plan);
    console.log('[jobs/process] export-thumbnail-selected', {
      export_id: bundle.id,
      ...thumbnailSelection,
    });
    const posterBytes = await readFile(posterPath);
    const posterObjectPath = makeExportThumbnailObjectPath(bundle.project.user_id, bundle.project_id, bundle.id);
    await uploadExportThumbnailObject(posterObjectPath, posterBytes);
  } catch (thumbnailError) {
    console.warn('[jobs/process] export-thumbnail-failed', {
      export_id: bundle.id,
      error: thumbnailError instanceof Error ? thumbnailError.message : 'Unknown thumbnail error',
    });
  }

  const doneUpdate = await supabase
    .from('exports')
    .update({
      status: 'done',
      output_storage_path: objectPath,
      hook_text: hookText,
      error_message: null,
      edit_status: useEditSettings ? 'rendered' : 'idle',
      updated_at: new Date().toISOString(),
    })
    .eq('id', bundle.id);

  let e1 = doneUpdate.error;
  if (e1 && isMissingEditColumnError(e1)) {
    console.warn('[jobs/process] edit_status column missing; saving rendered export without edit_status', { export_id: bundle.id });
    const fallbackDoneUpdate = await supabase
      .from('exports')
      .update({
        status: 'done',
        output_storage_path: objectPath,
        hook_text: hookText,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bundle.id);
    e1 = fallbackDoneUpdate.error;
  }

  if (e1) throw e1;
}

export async function POST(req: Request) {
  // Vercel requests are intentionally not render workers. Long FFmpeg jobs can
  // exceed the serverless request lifetime and leave exports in a retry loop.
  // The persistent Mac/VM worker calls this route on its own local Next server.
  if (process.env.VERCEL && process.env.ALLOW_SERVERLESS_MEDIA_PROCESSING !== 'true') {
    return NextResponse.json({ ok: true, processed: 0, delegated_to_external_worker: true });
  }
  const supabase = createAdminClient();
  const focusedExportId = new URL(req.url).searchParams.get('exportId')?.trim() || null;
  const stale = await requeueStaleProcessingWork().catch((error) => {
    console.warn('[jobs/process] stale requeue failed', error);
    return { staleJobs: 0, staleExports: 0 };
  });
  const repaired = await repairBrokenCompletedExports().catch((error) => {
    console.warn('[jobs/process] repair scan failed', error);
    return 0;
  });
  const recoveredTerminalErrors = await recoverTerminalRenderErrors().catch((error) => {
    console.warn('[jobs/process] terminal render recovery scan failed', error);
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

  if (focusedExportId) {
    const focusIndex = workItems.findIndex((item) => item.exportId === focusedExportId);
    if (focusIndex >= 0) {
      const [focused] = workItems.splice(focusIndex, 1);
      workItems.unshift(focused);
    } else {
      const { data: focusedJobs, error: focusError } = await supabase
        .from('jobs')
        .select('id, payload')
        .eq('status', 'queued')
        .eq('type', 'export')
        .order('created_at', { ascending: true })
        .limit(batchLimit * 2);

      if (focusError) return NextResponse.json({ error: focusError.message }, { status: 400 });

      const focusedJob = ((focusedJobs ?? []) as JobRow[]).find((job) => job.payload?.export_id === focusedExportId);
      if (focusedJob) {
        const focusedPayload = (focusedJob.payload as Record<string, unknown>) ?? {};
        workItems = [
          {
            jobId: focusedJob.id,
            exportId: String(focusedPayload.export_id ?? focusedExportId),
            payload: focusedPayload,
          },
          ...workItems.filter((item) => item.exportId !== focusedExportId),
        ].slice(0, batchLimit);
      }
    }
  }

  console.log('[jobs/process] queue snapshot', {
    queued_jobs_fetched: (jobs ?? []).length,
    work_items_selected: workItems.length,
    focused_export_id: focusedExportId,
    repaired_done_exports: repaired,
    recovered_terminal_errors: recoveredTerminalErrors,
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

      const { data: currentExport } = await supabase
        .from('exports')
        .select('project_id, status, output_storage_path')
        .eq('id', exportId)
        .maybeSingle();

      if (!isEditRerender && currentExport && hasPlayableOutput(currentExport)) {
        await supabase
          .from('exports')
          .update({ status: 'done', error_message: null, updated_at: new Date().toISOString() })
          .eq('id', exportId);

        if (item.jobId) {
          await supabase
            .from('jobs')
            .update({
              status: 'done',
              updated_at: new Date().toISOString(),
              payload: { ...item.payload, skipped: 'export_already_rendered' },
            })
            .eq('id', item.jobId);
        }

        const projectId = String(currentExport.project_id ?? '');
        if (projectId) {
          await maybeFinalizeProject(projectId).catch((finalizeError) => {
            console.warn('[jobs/process] finalize-after-existing-output failed', {
              project_id: projectId,
              export_id: exportId,
              error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
            });
          });
        }

        processed += 1;
        continue;
      }

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

      const renderProjectId = String(currentExport?.project_id ?? '');
      const stopHeartbeat = startExportHeartbeat({
        supabase,
        projectId: renderProjectId,
        exportId,
        jobId: item.jobId,
      });
      try {
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
          safe_layout_fallback: item.payload?.safe_layout_fallback === true,
          compatibility_fallback: item.payload?.compatibility_fallback === true,
        });
      } finally {
        await stopHeartbeat();
      }

      if (item.jobId) {
        await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', item.jobId);
      }
      const projectId = await getProjectIdForExport(exportId);
      try {
        const exportCleanupLog = await cleanupExportTempFiles(projectId, exportId);
        console.log('[cleanup] export-temp-files', { project_id: projectId, export_id: exportId, status: 'completed', ...summarizeCleanup(exportCleanupLog) });
      } catch (cleanupError) {
        console.warn('[cleanup] export-temp-files failed after successful render', {
          project_id: projectId,
          export_id: exportId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      if (!isEditRerender) {
        try {
          const terminal = await maybeFinalizeProject(projectId);
          if (terminal) {
            try {
              const cleanupLog = await cleanupProjectTempFiles(projectId);
              console.log('[cleanup] project-temp-files', { project_id: projectId, status: 'terminal', ...summarizeCleanup(cleanupLog) });
            } catch (cleanupError) {
              console.warn('[cleanup] project-temp-files failed after terminal render', {
                project_id: projectId,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              });
            }
          }
        } catch (finalizeError) {
          console.warn('[jobs/process] finalize failed after successful render', {
            project_id: projectId,
            export_id: exportId,
            error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
          });
        }
      }
      processed += 1;
    } catch (e: unknown) {
      const rawMessage = e instanceof Error ? e.message : 'Job failed';
      const failureDiagnostics = renderFailureDiagnostics(rawMessage);
      console.error('[jobs/process] export-failed', {
        export_id: item.exportId,
        job_id: item.jobId,
        raw_error: rawMessage,
        failure_category: failureDiagnostics.category,
        ffmpeg_stderr_tail: failureDiagnostics.stderrTail,
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

      const transientFailure = [
        'timeout',
        'memory_or_resource_failure',
        'missing_or_unreadable_input',
        'upload_or_storage_failure',
      ].includes(failureDiagnostics.category);
      const shouldRetry = Boolean(
        item.jobId
        && exportId
        && transientFailure
        && currentAttempts < TRANSIENT_RENDER_ATTEMPTS,
      );

      if (shouldRetry && item.jobId) {
        await supabase
          .from('jobs')
          .update({
            status: 'queued',
            updated_at: new Date().toISOString(),
            payload: {
              ...item.payload,
              retry_of_error: message,
              render_failure_category: failureDiagnostics.category,
              ffmpeg_stderr_tail: failureDiagnostics.stderrTail,
              repair: item.payload?.repair === true,
            },
          })
          .eq('id', item.jobId);

        if (exportId) {
          if (isEditRerender) {
            await supabase
              .from('exports')
              .update({
                edit_status: 'rendering',
                error_message: `Recovering clip update (${currentAttempts}/${TRANSIENT_RENDER_ATTEMPTS}): ${message}`,
                updated_at: new Date().toISOString(),
              })
              .eq('id', exportId);
          } else {
            await supabase
              .from('exports')
              .update({
                status: 'queued',
                error_message: `Recovering render (${currentAttempts}/${TRANSIENT_RENDER_ATTEMPTS}): ${message}`,
                updated_at: new Date().toISOString(),
              })
              .eq('id', exportId);
          }
        }

        continue;
      }

      const safeFallbackEligible = Boolean(
        item.jobId
        && exportId
        && !isEditRerender
        && item.payload?.safe_layout_fallback !== true
        && !['missing_or_unreadable_input', 'upload_or_storage_failure'].includes(failureDiagnostics.category),
      );

      if (safeFallbackEligible && item.jobId && exportId) {
        await supabase
          .from('jobs')
          .update({
            status: 'queued',
            attempts: 0,
            updated_at: new Date().toISOString(),
            payload: {
              ...item.payload,
              safe_layout_fallback: true,
              retry_of_error: message,
              render_failure_category: failureDiagnostics.category,
              ffmpeg_stderr_tail: failureDiagnostics.stderrTail,
            },
          })
          .eq('id', item.jobId);

        await supabase
          .from('exports')
          .update({
            status: 'queued',
            error_message: 'Finishing this reel with a safe alternate layout.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', exportId);

        console.warn('[jobs/process] safe-layout-fallback-queued', {
          export_id: exportId,
          job_id: item.jobId,
          failure_category: failureDiagnostics.category,
        });
        continue;
      }

      const compatibilityFallbackEligible = Boolean(
        item.jobId
        && exportId
        && !isEditRerender
        && item.payload?.safe_layout_fallback === true
        && item.payload?.compatibility_fallback !== true
        && !['missing_or_unreadable_input', 'upload_or_storage_failure'].includes(failureDiagnostics.category),
      );

      if (compatibilityFallbackEligible && item.jobId && exportId) {
        await supabase
          .from('jobs')
          .update({
            status: 'queued',
            attempts: 0,
            updated_at: new Date().toISOString(),
            payload: {
              ...item.payload,
              safe_layout_fallback: true,
              compatibility_fallback: true,
              automatic_recovery: true,
              retry_of_error: message,
              render_failure_category: failureDiagnostics.category,
              ffmpeg_stderr_tail: failureDiagnostics.stderrTail,
            },
          })
          .eq('id', item.jobId);

        await supabase
          .from('exports')
          .update({
            status: 'queued',
            error_message: 'Finishing this reel with a compatible render.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', exportId);

        console.warn('[jobs/process] compatibility-fallback-queued', {
          export_id: exportId,
          job_id: item.jobId,
          failure_category: failureDiagnostics.category,
        });
        continue;
      }

      if (item.jobId) {
        await supabase
          .from('jobs')
          .update({
            status: 'error',
            updated_at: new Date().toISOString(),
            payload: {
              ...item.payload,
              error: message,
              render_failure_category: failureDiagnostics.category,
              ffmpeg_stderr_tail: failureDiagnostics.stderrTail,
            },
          })
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

  return NextResponse.json({
    ok: true,
    processed,
    repaired,
    recoveredTerminalErrors,
    ensuredQueuedJobs,
    counts: {
      work_items_selected: workItems.length,
      processed,
      repaired,
      recovered_terminal_errors: recoveredTerminalErrors,
      ensured_queued_jobs: ensuredQueuedJobs,
    },
  });
}
