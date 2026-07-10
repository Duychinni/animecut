import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTargetClipCount } from '@/lib/clip-policy';
import { getPipelineErrorInfo, getPublicPipelineError } from '@/lib/pipeline-errors';
import { ensureProjectUploadThumbnail } from '@/lib/upload-thumbnail';

type ProjectStatus = 'created' | 'transcribed' | 'analyzed' | 'completed' | string;
type PipelineStatus = 'idle' | 'queued' | 'processing' | 'completed' | 'error' | string;
const PIPELINE_RECOVERY_STALE_MS = 90 * 1000;
const EXPORT_RECOVERY_STALE_MS = 4 * 60 * 1000;

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
  hasTranscript: boolean;
  analyzedCandidates: number;
  doneExports: number;
  activeExports: number;
  targetCount: number;
}) {
  const { status, pipelineStatus, pipelineStage, elapsedSeconds, hasTranscript, analyzedCandidates, doneExports, activeExports, targetCount } = params;
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
      const exportProgress = Math.min(1, doneExports / safeTarget);
      const activeBoost = activeExports > 0 ? 0.08 : 0;
      return Math.min(99, Math.round(start + Math.min(1, exportProgress + activeBoost + elapsedSeconds / 900) * (end - start)));
    }

    const stageRatio = Math.min(0.92, elapsedSeconds / expectedSeconds);
    return Math.min(99, Math.round(start + stageRatio * (end - start)));
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
  elapsedSeconds: number;
  hasTranscript: boolean;
  analyzedCandidates: number;
  doneExports: number;
  activeExports: number;
  targetCount: number;
  transcriptSeconds: number;
}) {
  const { status, pipelineStatus, elapsedSeconds, hasTranscript, analyzedCandidates, doneExports, activeExports, targetCount, transcriptSeconds } = params;

  if ((status === 'completed' || pipelineStatus === 'completed') && activeExports === 0 && doneExports >= Math.max(1, targetCount)) return 0;
  if (pipelineStatus === 'queued') return Math.max(20, Math.round(transcriptSeconds * 0.2) || 45);

  const safeTarget = Math.max(1, targetCount);
  const remainingExports = Math.max(0, safeTarget - doneExports);

  if (!hasTranscript) {
    const expected = Math.max(30, Math.round(transcriptSeconds * 0.18) || 120);
    return Math.max(15, expected - Math.min(elapsedSeconds, expected - 15));
  }

  if (hasTranscript && analyzedCandidates === 0) {
    const analyzeBudget = Math.max(20, Math.round(transcriptSeconds * 0.08) || 60);
    const exportTail = remainingExports > 0 ? remainingExports * 28 : 0;
    return Math.max(15, analyzeBudget + exportTail);
  }

  if (remainingExports <= 0) return activeExports > 0 ? 10 : 0;

  const throughputPerExport = doneExports > 0 ? elapsedSeconds / doneExports : 0;
  const boundedPerExport = throughputPerExport > 0 ? Math.max(12, Math.min(55, throughputPerExport)) : 28;
  const parallelism = Math.max(1, activeExports || 1);
  return Math.max(8, Math.round((remainingExports * boundedPerExport) / parallelism));
}

function isRecoverablePipelineError(error: unknown, stage: string | null) {
  if (stage === 'source_blocked') return false;
  const info = getPipelineErrorInfo(error);
  return info.code !== 'youtube_source_blocked' && info.code !== 'not_enough_content';
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

  await admin
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
    .lt('updated_at', cutoffIso)
    .limit(20);

  const exportIds = (staleExports ?? []).map((row) => String(row.id)).filter(Boolean);
  if (!exportIds.length) return 0;

  await admin
    .from('exports')
    .update({
      status: 'queued',
      error_message: 'Requeued after stalled render worker.',
      updated_at: now,
    })
    .in('id', exportIds);

  await admin
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

  return exportIds.length;
}

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const [{ data: project, error: pErr }, { data: exportsRows, error: eErr }, { count: candidateCount, error: cErr }, { data: transcriptRow }] = await Promise.all([
      supabase
        .from('projects')
        .select('id, user_id, title, status, pipeline_status, pipeline_stage, pipeline_stage_label, pipeline_progress_percent, worker_last_seen_at, worker_last_log_message, pipeline_error, source_type, source_url, source_storage_path, source_thumbnail_url, source_duration_seconds, created_at, updated_at')
        .eq('id', projectId)
        .single(),
      supabase
        .from('exports')
        .select('status, updated_at, created_at')
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

    const rows = exportsRows ?? [];
    const pipelineJobs = (jobRows ?? []).filter((row) => row.type === 'pipeline');
    const exportJobs = (jobRows ?? []).filter((row) => row.type === 'export');
    const latestPipelineJob = pipelineJobs[0] ?? null;
    const doneExports = rows.filter((r) => r.status === 'done').length;
    const projectMarkedCompleted = project.status === 'completed' || project.pipeline_status === 'completed';
    const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length;
    const failedExports = rows.filter((r) => r.status === 'error').length;

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

    const storedPipelineStatus = ((project as { pipeline_status?: string | null }).pipeline_status ?? 'idle') as string;
    const lastSeenRaw = (project as { worker_last_seen_at?: string | null }).worker_last_seen_at ?? null;
    const lastSeenMs = lastSeenRaw ? new Date(lastSeenRaw).getTime() : 0;
    const heartbeatExpired = activeExports === 0
      && storedPipelineStatus === 'processing'
      && lastSeenMs > 0
      && (Date.now() - lastSeenMs) > PIPELINE_RECOVERY_STALE_MS;
    const hasPlayableExports = doneExports > 0;
    const frozenCompletedProject = projectMarkedCompleted && hasPlayableExports;
    const hasSettledPlayableExports = activeExports === 0 && hasPlayableExports;
    const isReallyCompleted =
      frozenCompletedProject
      || (hasSettledPlayableExports && (projectMarkedCompleted || doneExports >= targetCount || storedPipelineStatus === 'error' || heartbeatExpired));

    const projectNeedsExportCompletion = !isReallyCompleted && projectMarkedCompleted && activeExports > 0;
    const effectiveStatus = isReallyCompleted ? 'completed' : projectNeedsExportCompletion ? 'analyzed' : (project.status as string);
    let pipelineStatus = isReallyCompleted ? 'completed' : storedPipelineStatus;
    const storedPipelineStage = (project as { pipeline_stage?: string | null }).pipeline_stage ?? null;
    const inFinalRenderPhase = !isReallyCompleted && (storedPipelineStage === 'uploading_outputs' || (activeExports > 0 && doneExports > 0));
    const pipelineStage = inFinalRenderPhase ? 'uploading_outputs' : storedPipelineStage;
    if (projectNeedsExportCompletion) {
      pipelineStatus = 'processing';
    }
    const hasTranscript = transcriptSegments.length > 0;
    const explicitPercent = Number((project as { pipeline_progress_percent?: number | null }).pipeline_progress_percent ?? NaN);
    const pipelineErrorRaw = (project as { pipeline_error?: string | null }).pipeline_error ?? null;
    const recoverableErrorState = !isReallyCompleted
      && activeExports === 0
      && doneExports === 0
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
    const shouldRecoverPipeline = staleWorker || recoverableErrorState || missingAnalysisWorker;
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
    const liveProgress = computeProgress({
      status: effectiveStatus,
      pipelineStatus,
      pipelineStage,
      elapsedSeconds,
      hasTranscript,
      analyzedCandidates,
      doneExports,
      activeExports,
      targetCount,
    });
    let progressPercent = isReallyCompleted
      ? 100
      : Math.max(Number.isFinite(explicitPercent) ? explicitPercent : 0, liveProgress);
    if (!isReallyCompleted) {
      progressPercent = Math.min(98, progressPercent);
    }

    const etaSeconds = estimateEtaSeconds({
      status: effectiveStatus,
      pipelineStatus,
      elapsedSeconds,
      hasTranscript,
      analyzedCandidates,
      doneExports,
      activeExports,
      targetCount,
      transcriptSeconds: totalSeconds,
    });

    if (isReallyCompleted && (project.status !== 'completed' || storedPipelineStatus !== 'completed')) {
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
    }

    const sourceUrl = typeof project.source_url === 'string' ? project.source_url : null;
    const storedThumbnailUrl = typeof (project as { source_thumbnail_url?: string | null }).source_thumbnail_url === 'string'
      ? (project as { source_thumbnail_url?: string | null }).source_thumbnail_url
      : null;
    const youtubeId = sourceUrl ? parseYouTubeId(sourceUrl) : null;
    let thumbnailUrl = storedThumbnailUrl || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg` : null);

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
      active_exports: activeExports,
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
      : analyzedCandidates === 0 && hasTranscript && pipelineStage === 'finding_hooks'
        ? 'Transcript exists, but no clip candidates have been saved yet. The analysis step is still running or was interrupted.'
      : activeExports > 0
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
        pipeline_error: isReallyCompleted || recoveryQueued || renderRecoveryQueued ? null : staleWorker ? getPublicPipelineError('Worker heartbeat expired after 5 minutes without progress update.') : pipelineErrorRaw,
        source_type: project.source_type,
        source_url: sourceUrl,
        thumbnail_url: thumbnailUrl,
        created_at: project.created_at,
        updated_at: project.updated_at,
      },
      progress: {
        percent: Math.max(0, Math.min(100, progressPercent)),
        done_exports: doneExports,
        active_exports: isReallyCompleted ? 0 : activeExports,
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
        active_exports: activeExports,
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
