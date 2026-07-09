import { NextResponse } from 'next/server';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveProjectVideoSource } from '@/lib/source';
import { renderVerticalClip, validateRenderedVideo } from '@/lib/ffmpeg';
import { segmentsToCapcutAss } from '@/lib/srt';
import { createExportSignedUrl, makeExportObjectPath, uploadExportObject } from '@/lib/storage';
import { cleanupProjectTempFiles, summarizeCleanup } from '@/lib/cleanup';
import { generateHookText } from '@/lib/hook-text';
import { getTargetClipCount } from '@/lib/clip-policy';
import { getCaptionPresetById, type CaptionFont, type CaptionTemplate } from '@/lib/caption-presets';
import { isLikelyMockTranscript, isMockTranscriptionEnabled } from '@/lib/dev-ai';

async function maybeFinalizeProject(projectId: string) {
  const supabase = createAdminClient();

  const [
    { count: total },
    { count: done },
    { count: failed },
    { data: transcriptRow },
    { count: candidateCount },
  ] = await Promise.all([
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'done'),
    supabase.from('exports').select('*', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'error'),
    supabase.from('transcripts').select('segments_json').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).single(),
    supabase.from('clip_candidates').select('*', { count: 'exact', head: true }).eq('project_id', projectId),
  ]);

  const totalCount = Number(total ?? 0);
  const doneCount = Number(done ?? 0);
  const failedCount = Number(failed ?? 0);
  const transcriptSegments = Array.isArray(transcriptRow?.segments_json) ? (transcriptRow.segments_json as { end?: number }[]) : [];
  const totalSeconds = transcriptSegments.reduce((acc, s) => Math.max(acc, Number(s?.end ?? 0)), 0);
  const targetCount = Math.max(1, getTargetClipCount(totalSeconds));
  const availableCandidates = Number(candidateCount ?? 0);

  if (doneCount >= targetCount) {
    await supabase
      .from('projects')
      .update({
        status: 'completed',
        pipeline_status: 'completed',
        pipeline_error: failedCount > 0 ? 'Some exports failed, but target reel count was reached.' : null,
        pipeline_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);
    return;
  }

  const candidatePoolExhausted = totalCount >= availableCandidates && availableCandidates > 0;
  const allAttemptsSettled = totalCount > 0 && doneCount + failedCount >= totalCount;

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
  }
}

type JobRow = { id: string; payload: { export_id?: string } };

async function getProjectIdForExport(exportId: string) {
  const supabase = createAdminClient();
  const { data } = await supabase.from('exports').select('project_id').eq('id', exportId).maybeSingle();
  return String(data?.project_id ?? '');
}

type ExportBundle = {
  id: string;
  project_id: string;
  clip_candidate_id: string;
  caption_preset_id?: string | null;
  hook_text_enabled?: boolean | null;
  hook_text?: string | null;
  project: {
    id: string;
    user_id: string;
    source_type: 'youtube' | 'upload';
    source_url?: string | null;
    source_storage_path?: string | null;
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
};

const EXPORT_MAX_RENDER_ATTEMPTS = 3;
const REPAIR_SCAN_LIMIT = 6;
const STALE_PROCESSING_MINUTES = 10;

function getWorkerBatchLimit() {
  const raw = Number(process.env.EXPORT_WORKER_BATCH_SIZE ?? 6);
  if (!Number.isFinite(raw)) return 6;
  return Math.max(1, Math.min(10, Math.round(raw)));
}

function normalizeRenderErrorMessage(message: string) {
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
    payload: { export_id: exportId, repair: true },
    status: 'queued',
  });

  if (error) throw error;
  return true;
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
    .select('id, project_id, clip_candidate_id, caption_preset_id, hook_text_enabled, hook_text')
    .eq('id', exportId)
    .single();
  if (error || !ex) throw new Error('Export row not found');

  const [{ data: project }, { data: clip }, { data: transcript }] = await Promise.all([
    supabase
      .from('projects')
      .select('id, user_id, source_type, source_url, source_storage_path')
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
    hook_text_enabled: ex.hook_text_enabled !== false,
    hook_text: typeof ex.hook_text === 'string' ? ex.hook_text : null,
    project: {
      id: String(project.id),
      user_id: String(project.user_id),
      source_type: project.source_type as 'youtube' | 'upload',
      source_url: (project.source_url as string | null) ?? null,
      source_storage_path: (project.source_storage_path as string | null) ?? null,
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

  const captionPreset = getCaptionPresetById(options?.caption_preset_id ?? bundle.caption_preset_id);
  const captionTemplate = options?.caption_template ?? captionPreset.caption_template;
  const captionFont = options?.caption_font ?? captionPreset.caption_font;
  const srtPath = path.join(exportDir, `${bundle.id}.ass`);
  const transcriptSegments = bundle.transcript?.segments_json ?? [];

  if (!isMockTranscriptionEnabled() && isLikelyMockTranscript(transcriptSegments)) {
    throw new Error('This export is using a mock transcript. Start a new project after disabling mock AI so captions can match the real audio.');
  }

  const captionText = segmentsToCapcutAss(transcriptSegments, bundle.clip.start_sec, bundle.clip.end_sec, {
    ...captionPreset,
    caption_template: captionTemplate,
  });

  const fallbackCaption = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Montserrat,88,&H00FFFFFF,&H0000FFFF,&H00141414,&H00000000,-1,0,0,0,120,108,0,0,1,4,0,2,40,40,380,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.50,Default,,0,0,0,,\n';
  await writeFile(srtPath, captionText || fallbackCaption);

  const hookTextEnabled = bundle.hook_text_enabled !== false && options?.hook_text_enabled !== false;
  const hookText = (typeof options?.hook_text === 'string' && options.hook_text.trim())
    || (bundle.hook_text?.trim())
    || generateHookText({
      clipTitle: bundle.clip.title ?? null,
      transcriptSegments,
      startSec: bundle.clip.start_sec,
      endSec: bundle.clip.end_sec,
    })
    || null;

  await renderVerticalClip({
    inputPath,
    outputPath: outPath,
    startSec: bundle.clip.start_sec,
    endSec: bundle.clip.end_sec,
    srtPath,
    captionsEnabled: options?.captions_enabled !== false,
    captionTemplate,
    captionFont,
    hookTextEnabled,
    hookText,
    motionTracking: options?.motion_tracking !== false,
    autoReframe: options?.auto_reframe !== false,
    reframeMode: options?.reframe_mode ?? 'smart',
    reframePreset: options?.reframe_preset ?? 'auto',
    debugClipId: bundle.id,
    debugCandidateId: bundle.clip_candidate_id,
  });

  await validateRenderedVideo(outPath);

  const bytes = await readFile(outPath);
  const objectPath = makeExportObjectPath(bundle.project.user_id, bundle.project_id, bundle.id);
  await uploadExportObject(objectPath, bytes);

  const { error: e1 } = await supabase
    .from('exports')
    .update({ status: 'done', output_storage_path: objectPath, error_message: null, updated_at: new Date().toISOString() })
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
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(batchLimit * 2);

    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 400 });

    for (const row of queuedExports ?? []) {
      const exportId = String(row.id);
      if (alreadySelectedExportIds.has(exportId)) continue;
      workItems.push({
        jobId: null,
        exportId,
        payload: { export_id: exportId },
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

        await supabase
          .from('jobs')
          .update({ status: 'processing', attempts: attemptNumber, updated_at: new Date().toISOString() })
          .eq('id', item.jobId);
      }

      const exportId = item.exportId;
      if (!exportId) throw new Error('Missing export_id in payload');

      await supabase
        .from('exports')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', exportId);

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
      });

      if (item.jobId) {
        await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', item.jobId);
      }
      const projectId = await getProjectIdForExport(exportId);
      const cleanupLog = await cleanupProjectTempFiles(projectId);
      console.log('[cleanup] project-temp-files', { project_id: projectId, status: 'completed', ...summarizeCleanup(cleanupLog) });
      await maybeFinalizeProject(projectId);
      processed += 1;
    } catch (e: unknown) {
      const rawMessage = e instanceof Error ? e.message : 'Job failed';
      console.error('[jobs/process] export-failed', {
        export_id: item.exportId,
        job_id: item.jobId,
        raw_error: rawMessage,
        payload: item.payload,
      });
      const message = normalizeRenderErrorMessage(rawMessage);
      const exportId = item.exportId;

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
          await supabase
            .from('exports')
            .update({
              status: 'queued',
              error_message: `Retrying render (${currentAttempts}/${EXPORT_MAX_RENDER_ATTEMPTS}): ${message}`,
              output_storage_path: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', exportId);
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
          .update({ status: 'error', error_message: message, updated_at: new Date().toISOString() })
          .eq('id', exportId);
        const projectId = await getProjectIdForExport(exportId);
        const cleanupLog = await cleanupProjectTempFiles(projectId);
        console.log('[cleanup] project-temp-files', { project_id: projectId, status: 'failed', ...summarizeCleanup(cleanupLog) });

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

        await maybeFinalizeProject(projectId);
      }
    }
  }

  console.log('[jobs/process] results', {
    work_items_selected: workItems.length,
    processed,
  });

  return NextResponse.json({ ok: true, processed, repaired, counts: { work_items_selected: workItems.length, processed, repaired } });
}
