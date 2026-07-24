import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTargetClipCount } from '@/lib/clip-policy';
import { getPipelineErrorInfo, getPublicPipelineError } from '@/lib/pipeline-errors';
import { ensureProjectUploadThumbnail } from '@/lib/upload-thumbnail';
import { stableYouTubeThumbnail } from '@/lib/source-metadata';
import { hasSettledPlayableExports } from '@/lib/project-completion';

type ProjectStatus = 'created' | 'transcribed' | 'analyzed' | 'completed' | string;
type PipelineStatus = 'idle' | 'queued' | 'processing' | 'completed' | 'error' | string;
const PIPELINE_RECOVERY_STALE_MS = 90 * 1000;
const EXPORT_RECOVERY_STALE_MS = 4 * 60 * 1000;

function hasPlayableOutput(row: { status?: string | null; output_storage_path?: string | null }) {
  return row.status !== 'error'
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://');
}

function parseYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.replace('/', '') || null;
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch {
    return null;
  }
}

function computeProgress(params: {
  status: ProjectStatus;
  pipelineStatus: PipelineStatus;
  pipelineStage: string | null;
  elapsedSeconds: number;
  stageElapsedSeconds: number;
  hasTranscript: boolean;
  analyzedCandidates: number;
  doneExports: number;
  activeExports: number;
  targetCount: number;
}) {
  const { status, pipelineStatus, pipelineStage, elapsedSeconds, stageElapsedSeconds, hasTranscript, analyzedCandidates, doneExports, activeExports, targetCount } = params;
  const safeTarget = Math.max(1, targetCount);

  if ((status === 'completed' || pipelineStatus === 'completed') && activeExports === 0 && doneExports >= safeTarget) return 100;
  if (pipelineStatus === 'error') return Math.max(5, Math.min(95, doneExports > 0 ? 70 : 12));

  const stageWindows: Record<string, [number, number, number]> = {
    queued: [3, 8, 35],
    downloading: [8, 14, 35],
    extracting_audio: [14, 24, 45],
    transcribing: [24, 44, 150],
    finding_hooks: [44, 60, 90],
    creating_clips: [60, 70, 45],
    face_tracking_crop: [70, 78, 45],
    rendering: [72, 96, 240],
    uploading_outputs: [96, 98, 35],
  };

  if (pipelineStage && stageWindows[pipelineStage]) {
    const [start, end, expectedSeconds] = stageWindows[pipelineStage];
    if (pipelineStage === 'rendering') {
      const completedRatio = Math.min(1, doneExports / safeTarget);
      const timeRatio = 1 - Math.exp(-Math.max(0, stageElapsedSeconds) / Math.max(45, safeTarget * 50));
      const nextExportCeiling = Math.min(0.98, (doneExports + (activeExports > 0 ? 0.9 : 0.35)) / safeTarget);
      const renderRatio = Math.max(completedRatio, Math.min(nextExportCeiling, timeRatio + (activeExports > 0 ? 0.025 : 0)));
      return Math.min(98, Math.round((start + renderRatio * (end - start)) * 10) / 10);
    }

    const stageRatio = Math.min(0.97, 1 - Math.exp(-Math.max(0, stageElapsedSeconds) / Math.max(1, expectedSeconds * 0.55)));
    return Math.min(98, Math.round((start + stageRatio * (end - start)) * 10) / 10);
  }

  if (!hasTranscript) {
    if (pipelineStatus === 'queued') return 8;
    if (pipelineStatus === 'processing') return Math.min(44, 10 + Math.floor(elapsedSeconds / 4));
    return Math.min(24, 6 + Math.floor(elapsedSeconds / 4));
  }

  if (hasTranscript && analyzedCandidates === 0) {
    return Math.min(64, 38 + Math.floor(elapsedSeconds / 8));
  }

  const exportProgress = doneExports / safeTarget;
  const activeBoost = activeExports > 0 ? 4 : 0;
  return Math.min(98, Math.round(68 + exportProgress * 28 + activeBoost));
}

function estimateEtaSeconds(params: {
  status: ProjectStatus;
  pipelineStatus: PipelineStatus;
  pipelineStage: string | null;
  elapsedSeconds: number;
  stageElapsedSeconds: number;
  hasTranscript: boolean;
  analyzedCandidates: number;
  doneExports: number;
  activeExports: number;
  targetCount: number;
  transcriptSeconds: number;
  renderSecondsPerClip: number;
}) {
  const {
    status,
    pipelineStatus,
    pipelineStage,
    elapsedSeconds,
    stageElapsedSeconds,
    hasTranscript,
    analyzedCandidates,
    doneExports,
    activeExports,
    targetCount,
    transcriptSeconds,
    renderSecondsPerClip,
  } = params;

  if ((status === 'completed' || pipelineStatus === 'completed') && activeExports === 0 && doneExports >= Math.max(1, targetCount)) return 0;
  if (pipelineStatus === 'error') return null;

  const safeTarget = Math.max(1, targetCount);
  const remainingExports = Math.max(0, safeTarget - doneExports);
  const sourceSeconds = Math.max(60, transcriptSeconds || 0);
  const stageBudgets: Record<string, number> = {
    queued: 20,
    downloading: Math.max(25, Math.min(90, Math.round(sourceSeconds * 0.06))),
    extracting_audio: Math.max(20, Math.min(80, Math.round(sourceSeconds * 0.08))),
    transcribing: Math.max(45, Math.min(240, Math.round(sourceSeconds * 0.22))),
    finding_hooks: Math.max(30, Math.min(120, Math.round(sourceSeconds * 0.1))),
    creating_clips: 18,
    face_tracking_crop: Math.max(15, Math.min(70, remainingExports * 8)),
    rendering: Math.max(25, Math.round((Math.max(1, remainingExports || activeExports) * renderSecondsPerClip) / Math.max(1, Math.min(3, activeExports || 1)))),
    uploading_outputs: 12,
  };

  const stageOrder = ['queued', 'downloading', 'extracting_audio', 'transcribing', 'finding_hooks', 'creating_clips', 'face_tracking_crop', 'rendering', 'uploading_outputs'];
  const effectiveStage = pipelineStage && stageBudgets[pipelineStage]
    ? pipelineStage
    : !hasTranscript
      ? 'transcribing'
      : analyzedCandidates === 0
        ? 'finding_hooks'
        : remainingExports > 0 || activeExports > 0
          ? 'rendering'
          : 'uploading_outputs';

  if (effectiveStage === 'rendering') {
    if (remainingExports <= 0) return activeExports > 0 ? Math.max(8, Math.round(renderSecondsPerClip / Math.max(1, activeExports))) : 8;
    const parallelism = Math.max(1, Math.min(3, activeExports || 1));
    return Math.max(10, Math.round((remainingExports * renderSecondsPerClip) / parallelism) + 10);
  }

  if (effectiveStage === 'uploading_outputs') return Math.max(4, stageBudgets.uploading_outputs - Math.min(stageElapsedSeconds, stageBudgets.uploading_outputs - 4));

  const currentIndex = Math.max(0, stageOrder.indexOf(effectiveStage));
  const currentBudget = stageBudgets[effectiveStage] ?? 30;
  const currentRemaining = Math.max(6, currentBudget - Math.min(stageElapsedSeconds, currentBudget - 6));
  const futureStageSeconds = stageOrder
    .slice(currentIndex + 1)
    .filter((stage) => {
      if (hasTranscript && (stage === 'transcribing' || stage === 'extracting_audio')) return false;
      if (analyzedCandidates > 0 && (stage === 'finding_hooks' || stage === 'creating_clips')) return false;
      return true;
    })
    .reduce((sum, stage) => sum + (stageBudgets[stage] ?? 0), 0);

  const elapsedCorrection = Math.min(30, Math.floor(elapsedSeconds / 12));
  return Math.max(8, Math.round(currentRemaining + futureStageSeconds - elapsedCorrection));
}

function isRecoverablePipelineError(error: unknown, stage: string | null) {
  if (stage === 'source_blocked') return false;
  const info = getPipelineErrorInfo(error);
  return info.code !== 'youtube_source_blocked' && info.code !== 'not_enough_content';
}

function isRetryableRenderError(message: string | null | undefined) {
  return /render failed|ffmpeg|video filter|filter not found|required video filter|retry the export|corrupted|skipped because this project is already completed|clip_edit_settings|edit_status|schema cache|could not find|PGRST204|42703/i.test(message ?? '');
}

function secondsSince(value: string | null | undefined, now = Date.now()) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(0, Math.round((now - ms) / 1000));
}

async function recoverPipeline(projectId: string) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: activeJob } = await admin
    .from('jobs')
    .select('id, status, payload')
    .eq('project_id', projectId)
    .eq('type', 'pipeline')
    .in('status', ['queued', 'processing'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeJob?.id) {
    await admin
      .from('jobs')
      .update({
        status: 'queued',
        payload: { ...((activeJob.payload as Record<string, unknown> | null) ?? {}), recovered_from_progress_poll: true },
        updated_at: now,
      })
      .eq('id', activeJob.id);
  } else {
    await admin.from('jobs').insert({
      project_id: projectId,
      type: 'pipeline',
      payload: { project_id: projectId, recovered_from_progress_poll: true },
      status: 'queued',
    });
  }

  const { error: projectUpdateError } = await admin
    .from('projects')
    .update({
      pipeline_status: 'queued',
      pipeline_stage: 'queued',
      pipeline_stage_label: 'Reconnecting worker',
      pipeline_error: null,
      worker_last_seen_at: now,
      worker_last_log_message: 'Reconnecting worker',
      updated_at: now,
    })
    .eq('id', projectId);
}

async function recoverStaleProjectExports(projectId: string, cutoffIso: string) {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: staleExports } = await admin
    .from('exports')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'processing')
    .is('output_storage_path', null)
    .lt('updated_at', cutoffIso)
    .limit(20);

  const exportIds = (staleExports ?? []).map((row) => String(row.id)).filter(Boolean);
  if (!exportIds.length) return 0;

  const { error: exportUpdateError } = await admin
    .from('exports')
    .update({
      status: 'queued',
      error_message: 'Requeued after stalled render worker.',
      updated_at: now,
    })
    .in('id', exportIds);

  if (exportUpdateError) throw exportUpdateError;

  const { error: projectUpdateError } = await admin
    .from('projects')
    .update({
      pipeline_status: 'processing',
      pipeline_stage: 'rendering',
      pipeline_stage_label: 'Reconnecting render worker',
      pipeline_error: null,
      worker_last_seen_at: now,
      worker_last_log_message: 'Reconnecting render worker',
      updated_at: now,
    })
    .eq('id', projectId);

  if (projectUpdateError) throw projectUpdateError;

  return exportIds.length;
}

async function recoverErroredProjectExports(projectId: string, exportIds: string[]) {
  if (!exportIds.length) return 0;

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { error: exportUpdateError } = await admin
    .from('exports')
    .update({
      status: 'queued',
      output_storage_path: null,
      error_message: 'Requeued after render compatibility repair.',
      updated_at: now,
    })
    .in('id', exportIds);

  if (exportUpdateError) throw exportUpdateError;

  const { data: activeJobs, error: activeJobsError } = await admin
    .from('jobs')
    .select('payload')
    .eq('project_id', projectId)
    .eq('type', 'export')
    .in('status', ['queued', 'processing']);

  if (activeJobsError) throw activeJobsError;

  const activeExportIds = new Set(
    (activeJobs ?? [])
      .map((job) => (job.payload as { export_id?: unknown } | null)?.export_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  const jobsToInsert = exportIds
    .filter((exportId) => !activeExportIds.has(exportId))
    .map((exportId) => ({
      project_id: projectId,
      type: 'export' as const,
      payload: { export_id: exportId, repair: true, recovered_from_progress_poll: true },
      status: 'queued' as const,
    }));

  if (jobsToInsert.length) {
    const { error: insertError } = await admin.from('jobs').insert(jobsToInsert);
    if (insertError) throw insertError;
  }

  const { error: projectUpdateError } = await admin
    .from('projects')
    .update({
      status: 'processing',
      pipeline_status: 'processing',
      pipeline_stage: 'rendering',
      pipeline_stage_label: 'Reconnecting render worker',
      pipeline_error: null,
      worker_last_seen_at: now,
      worker_last_log_message: 'Reconnecting render worker',
      updated_at: now,
    })
    .eq('id', projectId);

  if (projectUpdateError) throw projectUpdateError;

  return exportIds.length;
}

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const [{ data: project, error: pErr }, { data: exportsRows, error: eErr }, { count: candidateCount, error: cErr }, { data: transcriptRow }] = await Promise.all([
      supabase
        .from('projects')
        .select('id, user_id, title, status, pipeline_status, pipeline_stage, pipeline_stage_label, pipeline_progress_percent, pipeline_completed_at, worker_last_seen_at, worker_last_log_message, pipeline_error, source_type, source_url, source_storage_path, source_thumbnail_url, source_duration_seconds, created_at, updated_at')
        .eq('id', projectId)
        .single(),
      supabase
        .from('exports')
        .select('id, status, output_storage_path, error_message, edit_status, updated_at, created_at')
        .eq('project_id', projectId),
      supabase
        .from('clip_candidates')
        .select('*', { count: 'exact', head: true })
        .eq('project_id', projectId),
      supabase
        .from('transcripts')
        .select('segments_json')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
    ]);

    if (pErr || !project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (eErr) return NextResponse.json({ error: eErr.message }, { status: 400 });
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 });

    const admin = createAdminClient();
    const { data: jobRows } = await admin
      .from('jobs')
      .select('id, type, status, attempts, created_at, updated_at, payload')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false })
      .limit(8);
    const { count: activeJobCount } = await admin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .in('type', ['pipeline', 'export'])
      .in('status', ['queued', 'processing']);

    const rows = exportsRows ?? [];
    const processingRowsWithSavedOutput = rows
      .filter((row) => row.status === 'processing' && hasPlayableOutput(row) && typeof row.id === 'string')
      .map((row) => String(row.id));
    if (processingRowsWithSavedOutput.length) {
      await admin
        .from('exports')
        .update({ status: 'done', error_message: null, updated_at: new Date().toISOString() })
        .in('id', processingRowsWithSavedOutput);
    }
    const pipelineJobs = (jobRows ?? []).filter((row) => row.type === 'pipeline');
    const exportJobs = (jobRows ?? []).filter((row) => row.type === 'export');
    const latestPipelineJob = pipelineJobs[0] ?? null;
    const doneExports = rows.filter(hasPlayableOutput).length;
    const activeEdits = rows.filter((row) => (row as { edit_status?: string | null }).edit_status === 'rendering').length;
    const projectMarkedCompleted = project.status === 'completed'
      || project.pipeline_status === 'completed'
      || Boolean((project as { pipeline_completed_at?: string | null }).pipeline_completed_at);
    const activeExports = rows.filter((r) => (r.status === 'queued' || r.status === 'processing') && !hasPlayableOutput(r)).length;
    const failedExports = rows.filter((r) => r.status === 'error' && !hasPlayableOutput(r)).length;
    const retryableErroredExportIds = rows
      .filter((row) => row.id && row.status === 'error' && !hasPlayableOutput(row) && isRetryableRenderError((row as { error_message?: string | null }).error_message))
      .map((row) => String(row.id));

    const analyzedCandidates = Math.max(0, Number(candidateCount ?? 0));
    const transcriptSegments = Array.isArray(transcriptRow?.segments_json) ? (transcriptRow?.segments_json as { end?: number }[]) : [];
    const transcriptSeconds = transcriptSegments.reduce((acc, s) => Math.max(acc, Number(s?.end ?? 0)), 0);
    const sourceDurationSeconds = Number((project as { source_duration_seconds?: number | null }).source_duration_seconds ?? 0);
    const totalSeconds = transcriptSeconds > 0 ? transcriptSeconds : sourceDurationSeconds;
    const desiredTarget = getTargetClipCount(totalSeconds);
    const targetCount = Math.max(1, desiredTarget);

    const now = Date.now();
    const createdAtMs = project.created_at ? new Date(project.created_at).getTime() : now;
    const elapsedSeconds = Math.max(0, Math.round((now - createdAtMs) / 1000));
    const updatedAtMs = project.updated_at ? new Date(project.updated_at).getTime() : now;
    const stageElapsedSeconds = Math.max(0, Math.round((now - (Number.isFinite(updatedAtMs) ? updatedAtMs : now)) / 1000));
    const completedRenderDurations = rows
      .filter(hasPlayableOutput)
      .map((row) => {
        const start = row.created_at ? new Date(row.created_at).getTime() : 0;
        const end = row.updated_at ? new Date(row.updated_at).getTime() : 0;
        if (!start || !end || end <= start) return 0;
        return Math.round((end - start) / 1000);
      })
      .filter((seconds) => seconds >= 8 && seconds <= 240);
    const averageCompletedRenderSeconds = completedRenderDurations.length
      ? completedRenderDurations.reduce((sum, seconds) => sum + seconds, 0) / completedRenderDurations.length
      : 0;
    const sourceRenderFactor = totalSeconds > 0 ? Math.max(0.8, Math.min(1.9, totalSeconds / 900)) : 1;
    const renderSecondsPerClip = Math.round(Math.max(18, Math.min(95, averageCompletedRenderSeconds || 34 * sourceRenderFactor)));

    const storedPipelineStatus = ((project as { pipeline_status?: string | null }).pipeline_status ?? 'idle') as string;
    const lastSeenRaw = (project as { worker_last_seen_at?: string | null }).worker_last_seen_at ?? null;
    const lastSeenMs = lastSeenRaw ? new Date(lastSeenRaw).getTime() : 0;
    const heartbeatExpired = activeExports === 0
      && storedPipelineStatus === 'processing'
      && lastSeenMs > 0
      && (Date.now() - lastSeenMs) > PIPELINE_RECOVERY_STALE_MS;
    const hasTargetCoverage = doneExports >= targetCount;
    const frozenCompletedProject = projectMarkedCompleted && doneExports > 0;
    const allCreatedExportsSettled = hasSettledPlayableExports({
      totalExports: rows.length,
      doneExports,
      failedExports,
      activeExports,
      activeJobs: Number(activeJobCount ?? 0),
    });
    const hasSettledPlayableOutput = (activeExports === 0 && hasTargetCoverage) || allCreatedExportsSettled;
    // Explicit completion is a durable latch for saved projects. The target
    // count still gates new projects that have not been finalized yet, but a
    // later policy change must never reopen an older completed project.
    const isReallyCompleted = frozenCompletedProject || hasSettledPlayableOutput;

    const projectNeedsExportCompletion = !isReallyCompleted && projectMarkedCompleted && doneExports < targetCount;
    let effectiveStatus = isReallyCompleted ? 'completed' : projectNeedsExportCompletion ? 'analyzed' : (project.status as string);
    let pipelineStatus = isReallyCompleted ? 'completed' : storedPipelineStatus;
    const storedPipelineStage = (project as { pipeline_stage?: string | null }).pipeline_stage ?? null;
    const inFinalRenderPhase = !isReallyCompleted && storedPipelineStage === 'uploading_outputs' && activeExports === 0 && doneExports > 0;
    const pipelineStage = !isReallyCompleted && activeExports > 0 ? 'rendering' : inFinalRenderPhase ? 'uploading_outputs' : storedPipelineStage;
    if (projectNeedsExportCompletion) {
      pipelineStatus = 'processing';
    }
    if (!isReallyCompleted && activeExports > 0) {
      pipelineStatus = 'processing';
    }
    const hasTranscript = transcriptSegments.length > 0;
    const explicitPercent = Number((project as { pipeline_progress_percent?: number | null }).pipeline_progress_percent ?? NaN);
    const pipelineErrorRaw = (project as { pipeline_error?: string | null }).pipeline_error ?? null;
    const recoverableErrorState = !isReallyCompleted
      && activeExports === 0
      && doneExports === 0
      && retryableErroredExportIds.length === 0
      && storedPipelineStatus === 'error'
      && isRecoverablePipelineError(pipelineErrorRaw, storedPipelineStage);
    const staleWorker = !isReallyCompleted && heartbeatExpired;
    const missingAnalysisWorker = !isReallyCompleted
      && activeExports === 0
      && doneExports === 0
      && hasTranscript
      && analyzedCandidates === 0
      && storedPipelineStatus === 'processing'
      && storedPipelineStage === 'finding_hooks'
      && (!latestPipelineJob || latestPipelineJob.status !== 'processing');
    const completedWithoutPlayableExports = !isReallyCompleted
      && projectMarkedCompleted
      && activeExports === 0
      && doneExports === 0
      && (hasTranscript || analyzedCandidates > 0);
    const shouldRecoverPipeline = staleWorker || recoverableErrorState || missingAnalysisWorker || completedWithoutPlayableExports;
    let recoveryQueued = false;
    if (shouldRecoverPipeline) {
      try {
        await recoverPipeline(projectId);
        recoveryQueued = true;
      } catch (recoveryError) {
        console.warn('[projects/progress] pipeline recovery failed', {
          project_id: projectId,
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        });
      }
    }
    if (recoveryQueued) {
      pipelineStatus = 'queued';
    }
    let renderRecoveryQueued = false;
    let recoveredErrorExportCount = 0;
    const staleExportCutoffMs = Date.now() - EXPORT_RECOVERY_STALE_MS;
    const hasStaleRenderExport = !isReallyCompleted
      && activeExports > 0
      && rows.some((row) => {
        if (row.status !== 'processing') return false;
        const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : 0;
        return updatedAtMs > 0 && updatedAtMs < staleExportCutoffMs;
      });
    if (hasStaleRenderExport) {
      try {
        const recoveredExports = await recoverStaleProjectExports(projectId, new Date(staleExportCutoffMs).toISOString());
        renderRecoveryQueued = recoveredExports > 0;
      } catch (renderRecoveryError) {
        console.warn('[projects/progress] render recovery failed', {
          project_id: projectId,
          error: renderRecoveryError instanceof Error ? renderRecoveryError.message : String(renderRecoveryError),
        });
      }
    }
    if (!isReallyCompleted && doneExports < targetCount && retryableErroredExportIds.length) {
      try {
        recoveredErrorExportCount = await recoverErroredProjectExports(projectId, retryableErroredExportIds);
        renderRecoveryQueued = recoveredErrorExportCount > 0 || renderRecoveryQueued;
      } catch (renderRecoveryError) {
        console.warn('[projects/progress] errored render recovery failed', {
          project_id: projectId,
          error: renderRecoveryError instanceof Error ? renderRecoveryError.message : String(renderRecoveryError),
        });
      }
    }
    if (renderRecoveryQueued) {
      pipelineStatus = 'processing';
      effectiveStatus = 'analyzed';
    }
    const visibleActiveExports = activeExports + recoveredErrorExportCount;
    const liveProgress = computeProgress({
      status: effectiveStatus,
      pipelineStatus,
      pipelineStage: renderRecoveryQueued ? 'rendering' : pipelineStage,
      elapsedSeconds,
      stageElapsedSeconds,
      hasTranscript,
      analyzedCandidates,
      doneExports,
      activeExports: visibleActiveExports,
      targetCount,
    });
    let progressPercent = isReallyCompleted
      ? 100
      : Math.max(Number.isFinite(explicitPercent) ? explicitPercent : 0, liveProgress);
    if (!isReallyCompleted) {
      progressPercent = Math.min(98, progressPercent);
    }

    const etaSeconds = isReallyCompleted
      ? 0
      : estimateEtaSeconds({
          status: effectiveStatus,
          pipelineStatus,
          pipelineStage: renderRecoveryQueued ? 'rendering' : pipelineStage,
          elapsedSeconds,
          stageElapsedSeconds,
          hasTranscript,
          analyzedCandidates,
          doneExports,
          activeExports: visibleActiveExports,
          targetCount,
          transcriptSeconds: totalSeconds,
          renderSecondsPerClip,
        });

    if (isReallyCompleted && (project.status !== 'completed' || storedPipelineStatus !== 'completed')) {
      await supabase
        .from('projects')
        .update({
          status: 'exported',
          pipeline_status: 'completed',
          pipeline_stage: 'completed',
          pipeline_stage_label: 'Completed',
          pipeline_progress_percent: 100,
          pipeline_error: null,
          pipeline_completed_at: (project as { pipeline_completed_at?: string | null }).pipeline_completed_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', projectId);
    }

    const sourceUrl = typeof project.source_url === 'string' ? project.source_url : null;
    const storedThumbnailUrl = typeof (project as { source_thumbnail_url?: string | null }).source_thumbnail_url === 'string'
      ? (project as { source_thumbnail_url?: string | null }).source_thumbnail_url
      : null;
    const youtubeId = sourceUrl ? parseYouTubeId(sourceUrl) : null;
    let thumbnailUrl = stableYouTubeThumbnail(storedThumbnailUrl, youtubeId);

    if (project.source_type === 'upload') {
      const uploadThumbnailUrl = await ensureProjectUploadThumbnail({
        id: String(project.id),
        user_id: String((project as { user_id?: string }).user_id ?? ''),
        source_type: 'upload',
        source_storage_path: typeof (project as { source_storage_path?: string | null }).source_storage_path === 'string'
          ? (project as { source_storage_path?: string | null }).source_storage_path
          : null,
      }).catch((thumbnailError) => {
        console.warn('[projects/progress] upload-thumbnail failed', {
          project_id: projectId,
          error: thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError),
        });
        return null;
      });
      thumbnailUrl = uploadThumbnailUrl || thumbnailUrl;
    }

    console.log('[projects/progress] counts', {
      project_id: projectId,
      transcript_seconds: totalSeconds,
      analyzed_candidates: analyzedCandidates,
      done_exports: doneExports,
      active_exports: visibleActiveExports,
      failed_exports: failedExports,
      target_exports: targetCount,
    });

    const storedPipelineStageLabel = (project as { pipeline_stage_label?: string | null }).pipeline_stage_label ?? null;
    const displayPipelineStageLabel = isReallyCompleted
      ? 'Completed'
      : recoveryQueued
        ? 'Reconnecting worker'
      : renderRecoveryQueued
        ? 'Reconnecting render worker'
      : staleWorker
        ? 'Worker heartbeat expired'
        : visibleActiveExports > 0
          ? 'Rendering reels'
        : inFinalRenderPhase
          ? 'Finalizing reels'
          : storedPipelineStage === 'uploading_outputs'
            ? 'Finalizing reels'
            : storedPipelineStageLabel;
    const latestPipelinePayload = latestPipelineJob?.payload && typeof latestPipelineJob.payload === 'object'
      ? latestPipelineJob.payload as Record<string, unknown>
      : null;
    const secondsSinceHeartbeat = secondsSince(lastSeenRaw, now);
    const secondsSincePipelineJobUpdate = latestPipelineJob ? secondsSince(latestPipelineJob.updated_at as string | null, now) : null;
    const diagnosticMessage = isReallyCompleted
      ? 'Project has completed exports.'
      : recoveryQueued
        ? 'Pipeline job was stale and has been requeued by the progress check.'
      : renderRecoveryQueued
        ? 'A stale render export was requeued by the progress check.'
      : staleWorker
        ? 'Worker heartbeat expired while this project was processing.'
      : completedWithoutPlayableExports
        ? 'Project was marked complete without a playable saved reel; export recovery was queued.'
      : analyzedCandidates === 0 && hasTranscript && pipelineStage === 'finding_hooks'
        ? 'Transcript exists, but no clip candidates have been saved yet. The analysis step is still running or was interrupted.'
      : visibleActiveExports > 0
        ? 'Clip exports are queued or rendering.'
      : 'No obvious stall detected from saved progress state.';

    return NextResponse.json({
      ok: true,
      project: {
        id: project.id,
        title: project.title,
        status: effectiveStatus,
        pipeline_status: pipelineStatus,
        pipeline_stage: isReallyCompleted ? 'completed' : renderRecoveryQueued ? 'rendering' : pipelineStage,
        pipeline_stage_label: displayPipelineStageLabel,
        worker_last_seen_at: lastSeenRaw,
        worker_last_log_message: (project as { worker_last_log_message?: string | null }).worker_last_log_message ?? null,
        pipeline_error: isReallyCompleted || recoveryQueued || renderRecoveryQueued || visibleActiveExports > 0 ? null : staleWorker ? getPublicPipelineError('Worker heartbeat expired after 5 minutes without progress update.') : pipelineErrorRaw,
        source_type: project.source_type,
        source_url: sourceUrl,
        thumbnail_url: thumbnailUrl,
        created_at: project.created_at,
        updated_at: project.updated_at,
      },
      progress: {
        percent: Math.max(0, Math.min(100, progressPercent)),
        done_exports: doneExports,
        active_exports: isReallyCompleted ? 0 : visibleActiveExports,
        active_edits: activeEdits,
        target_exports: targetCount,
        elapsed_seconds: elapsedSeconds,
        eta_seconds: etaSeconds,
      },
      diagnostics: {
        message: diagnosticMessage,
        source_type: project.source_type,
        transcript_segments: transcriptSegments.length,
        transcript_seconds: totalSeconds,
        analyzed_candidates: analyzedCandidates,
        done_exports: doneExports,
        active_exports: visibleActiveExports,
        active_edits: activeEdits,
        failed_exports: failedExports,
        target_exports: targetCount,
        recovery_queued: recoveryQueued,
        render_recovery_queued: renderRecoveryQueued,
        stale_worker: staleWorker,
        seconds_since_worker_heartbeat: secondsSinceHeartbeat,
        latest_pipeline_job: latestPipelineJob ? {
          status: latestPipelineJob.status,
          attempts: Number(latestPipelineJob.attempts ?? 0),
          seconds_since_update: secondsSincePipelineJobUpdate,
          created_at: latestPipelineJob.created_at,
          updated_at: latestPipelineJob.updated_at,
          retry_attempt: Number(latestPipelinePayload?.retry_attempt ?? 0) || null,
          retry_of_error: typeof latestPipelinePayload?.retry_of_error === 'string'
            ? String(latestPipelinePayload.retry_of_error)
            : null,
        } : null,
        recent_jobs: (jobRows ?? []).slice(0, 5).map((job) => ({
          type: job.type,
          status: job.status,
          attempts: Number(job.attempts ?? 0),
          seconds_since_update: secondsSince(job.updated_at as string | null, now),
        })),
        active_export_jobs: exportJobs.filter((job) => job.status === 'queued' || job.status === 'processing').length,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
