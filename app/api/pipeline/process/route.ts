import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPipelineErrorInfo } from '@/lib/pipeline-errors';
import { getClipPolicy } from '@/lib/clip-policy';
import { ensureSourceDiarization, isDiarizationEnabled } from '@/lib/media-intelligence/diarization';

export const maxDuration = 300;

const STEP_PROGRESS: Record<string, number> = {
  queued: 0,
  downloading: 5,
  extracting_audio: 10,
  transcribing: 25,
  diarizing: 32,
  finding_hooks: 40,
  creating_clips: 55,
  face_tracking_crop: 70,
  rendering: 85,
  uploading_outputs: 95,
  completed: 100,
};

const PIPELINE_MAX_ATTEMPTS = 3;
// Analysis can legitimately spend several minutes transcribing and scoring a
// long source. A 90-second lease caused a second request to reclaim a healthy
// job while the first request was still running. Keep this beyond the route's
// maximum lifetime; genuinely abandoned jobs are recovered on the next pass.
const STALE_PIPELINE_JOB_MS = 6 * 60 * 1000;

function getInternalBaseUrls() {
  return [
    // This route only performs media work on a persistent worker host. Keep
    // its heavy internal steps on that same host instead of bouncing through
    // the public Vercel deployment, which intentionally delegates media work.
    process.env.WORKER_API_URL,
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ].filter((v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i);
}

async function callInternalJson(path: string, body: Record<string, unknown>) {
  let lastError: string | null = null;

  for (const baseUrl of getInternalBaseUrls()) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = typeof data?.error === 'string'
          ? data.error
          : typeof data?.message === 'string'
            ? data.message
            : data && typeof data === 'object'
              ? JSON.stringify(data)
              : `Pipeline step failed: ${path}`;
        console.error('[pipeline] internal-call-failed', { path, baseUrl, status: res.status, data, lastError });
        continue;
      }

      return data;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : `Request failed for ${path}`;
    }
  }

  throw new Error(lastError || `Pipeline step failed: ${path}`);
}

async function updateProjectProgress(projectId: string, step: string, label: string, extra: Record<string, unknown> = {}) {
  const supabase = createAdminClient();
  const payload = {
    pipeline_status: step === 'completed' ? 'completed' : step === 'failed' ? 'error' : 'processing',
    pipeline_stage: step,
    pipeline_stage_label: label,
    pipeline_progress_percent: step === 'failed' ? undefined : (STEP_PROGRESS[step] ?? 0),
    worker_last_seen_at: new Date().toISOString(),
    worker_last_log_message: label,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  console.log('[pipeline/progress]', { projectId, step, label, extra });
  await supabase.from('projects').update(payload).eq('id', projectId);
}

async function getExportCounts(projectId: string) {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('exports')
    .select('status, output_storage_path')
    .eq('project_id', projectId);

  if (error) throw error;

  const rows = data ?? [];
  const hasPlayableOutput = (row: { status?: string | null; output_storage_path?: string | null }) => row.status !== 'error'
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://');

  return {
    total: rows.length,
    done: rows.filter(hasPlayableOutput).length,
    active: rows.filter((row) => (row.status === 'queued' || row.status === 'processing') && !hasPlayableOutput(row)).length,
    failed: rows.filter((row) => row.status === 'error').length,
  };
}

async function getTranscriptStats(projectId: string) {
  const supabase = createAdminClient();
  const [transcriptResult, projectResult] = await Promise.all([
    supabase
      .from('transcripts')
      .select('segments_json')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('projects')
      .select('source_duration_seconds')
      .eq('id', projectId)
      .maybeSingle(),
  ]);

  const { data, error } = transcriptResult;

  if (error) throw error;
  if (projectResult.error) throw projectResult.error;

  const segments = Array.isArray(data?.segments_json)
    ? (data?.segments_json as Array<{ end?: number }>)
    : [];
  const durationSeconds = segments.reduce((acc, segment) => Math.max(acc, Number(segment?.end ?? 0)), 0);
  const sourceDurationSeconds = Math.max(0, Number(projectResult.data?.source_duration_seconds ?? 0));

  return {
    exists: segments.length > 0,
    segmentCount: segments.length,
    durationSeconds,
    sourceDurationSeconds,
    policyDurationSeconds: Math.max(durationSeconds, sourceDurationSeconds),
  };
}

async function getCandidateCount(projectId: string) {
  const supabase = createAdminClient();
  const { count, error } = await supabase
    .from('clip_candidates')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);

  if (error) throw error;
  return Math.max(0, Number(count ?? 0));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export async function POST() {
  // Source download, transcription, analysis, and rendering belong on the
  // persistent media worker. Running them inside Vercel can terminate healthy
  // work at the serverless timeout and create duplicate retries.
  if (process.env.VERCEL && process.env.ALLOW_SERVERLESS_MEDIA_PROCESSING !== 'true') {
    return NextResponse.json({ ok: true, processed: 0, delegated_to_external_worker: true });
  }
  const supabase = createAdminClient();

  const { data: processingJobs, error: processingError } = await supabase
    .from('jobs')
    .select('id, project_id, updated_at, attempts, payload')
    .eq('type', 'pipeline')
    .eq('status', 'processing')
    .order('updated_at', { ascending: false })
    .limit(1);

  if (processingError) return NextResponse.json({ error: processingError.message }, { status: 400 });
  if (processingJobs?.length) {
    const processingJob = processingJobs[0];
    const updatedAtMs = processingJob.updated_at ? new Date(processingJob.updated_at).getTime() : 0;
    const isStale = updatedAtMs > 0 && Date.now() - updatedAtMs > STALE_PIPELINE_JOB_MS;

    if (!isStale) {
      return NextResponse.json({ ok: true, processed: 0, busy: true, project_id: processingJob.project_id });
    }

    await supabase
      .from('jobs')
      .update({
        status: 'queued',
        payload: { ...((processingJob.payload as Record<string, unknown> | null) ?? {}), requeued_after_stale_worker: true },
        updated_at: new Date().toISOString(),
      })
      .eq('id', processingJob.id);

    await supabase
      .from('projects')
      .update({
        pipeline_status: 'queued',
        pipeline_stage: 'queued',
        pipeline_stage_label: 'Reconnecting worker',
        pipeline_error: null,
        worker_last_log_message: 'Reconnecting worker',
        updated_at: new Date().toISOString(),
      })
      .eq('id', processingJob.project_id);
  }

  const { data: retryableErrorJobs, error: retryableError } = await supabase
    .from('jobs')
    .select('id, project_id, payload, attempts')
    .eq('type', 'pipeline')
    .eq('status', 'error')
    .lt('attempts', PIPELINE_MAX_ATTEMPTS)
    .order('updated_at', { ascending: true })
    .limit(1);

  if (retryableError) return NextResponse.json({ error: retryableError.message }, { status: 400 });
  const retryableJob = retryableErrorJobs?.[0];
  if (retryableJob?.id) {
    const payload = (retryableJob.payload as Record<string, unknown> | null) ?? {};
    const previousError = typeof payload.error === 'string' || typeof payload.retry_of_error === 'string'
      ? String(payload.error ?? payload.retry_of_error)
      : '';
    const previousErrorInfo = getPipelineErrorInfo(previousError);

    if (previousErrorInfo.code !== 'youtube_source_blocked') {
      await supabase
        .from('jobs')
        .update({
          status: 'queued',
          payload: { ...payload, requeued_after_error: true },
          updated_at: new Date().toISOString(),
        })
        .eq('id', retryableJob.id);

      await supabase
        .from('projects')
        .update({
          pipeline_status: 'queued',
          pipeline_stage: 'queued',
          pipeline_stage_label: 'Retrying processing',
          pipeline_error: null,
          worker_last_log_message: 'Retrying processing',
          updated_at: new Date().toISOString(),
        })
        .eq('id', retryableJob.project_id);
    }
  }

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, project_id, payload, status, attempts')
    .eq('type', 'pipeline')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!jobs?.length) return NextResponse.json({ ok: true, processed: 0 });

  const job = jobs[0];
  const projectId = String(job.project_id || job.payload?.project_id || '');
  if (!projectId) {
    return NextResponse.json({ error: 'Pipeline job missing project_id' }, { status: 400 });
  }

  const { data: savedProject } = await supabase
    .from('projects')
    .select('status, pipeline_status, pipeline_completed_at, exports(status, output_storage_path)')
    .eq('id', projectId)
    .maybeSingle();
  const savedProjectExports = Array.isArray(savedProject?.exports)
    ? savedProject.exports as Array<{ status?: string | null; output_storage_path?: string | null }>
    : [];
  const savedProjectHasPlayableOutput = savedProjectExports.some((row) => row.status !== 'error'
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://'));
  const savedProjectIsCompleted = savedProject?.status === 'completed'
    || savedProject?.pipeline_status === 'completed'
    || Boolean(savedProject?.pipeline_completed_at);

  if (savedProjectIsCompleted && savedProjectHasPlayableOutput) {
    await supabase
      .from('jobs')
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('id', job.id);
    return NextResponse.json({ ok: true, processed: 0, skipped: 'project_already_completed', project_id: projectId });
  }

  const processingTimestamp = new Date().toISOString();
  const attemptNumber = Number(job.attempts ?? 0) + 1;
  const { data: claimedJobs, error: claimError } = await supabase
    .from('jobs')
    .update({ status: 'processing', attempts: attemptNumber, updated_at: processingTimestamp })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('id')
    .limit(1);

  if (claimError) return NextResponse.json({ error: claimError.message }, { status: 400 });
  if (!claimedJobs?.length) {
    return NextResponse.json({ ok: true, processed: 0, skipped: 'claim_lost' });
  }

  await supabase
    .from('projects')
    .update({ pipeline_status: 'processing', pipeline_error: null, worker_started_at: new Date().toISOString(), worker_last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', projectId);

  await updateProjectProgress(projectId, 'downloading', 'Preparing source video');

  try {
    let transcriptStats = await getTranscriptStats(projectId);
    if (transcriptStats.exists) {
      console.log('[pipeline] resume-after-transcribe', { projectId, transcriptStats });
      await updateProjectProgress(projectId, 'finding_hooks', 'Finding hooks', {
        worker_last_log_message: 'Using saved transcript',
      });
    } else {
      await updateProjectProgress(projectId, 'extracting_audio', 'Extracting audio');
      console.log('[pipeline] before transcribe', { projectId });
      await updateProjectProgress(projectId, 'transcribing', 'Transcribing audio');
      await callInternalJson('/api/transcribe', { project_id: projectId });
      console.log('[pipeline] after transcribe', { projectId });
      transcriptStats = await getTranscriptStats(projectId);
    }

    if (isDiarizationEnabled(projectId)) {
      await updateProjectProgress(projectId, 'diarizing', 'Identifying anonymous speakers');
      const diarization = await ensureSourceDiarization(projectId);
      console.log('[pipeline:diarization]', {
        projectId,
        analysisRunId: diarization.analysisRunId,
        mode: diarization.mode,
        reused: diarization.reused,
        speakerCount: diarization.speakerCount,
        turnCount: diarization.turnCount,
        errorCategory: diarization.errorCategory ?? null,
      });
    }

    let candidateCount = await getCandidateCount(projectId);
    const expectedCandidateMinimum = getClipPolicy(transcriptStats.policyDurationSeconds).targetMin;
    let analyzeData: Record<string, unknown> = { ok: true, count: candidateCount, resumed: true };
    if (candidateCount >= expectedCandidateMinimum) {
      console.log('[pipeline] resume-after-analyze', { projectId, candidateCount, expectedCandidateMinimum });
    } else {
      let usedLocalAnalysis = false;
      await updateProjectProgress(projectId, 'finding_hooks', 'Finding hooks');
      console.log('[pipeline] before analyze', {
        projectId,
        transcriptStats,
        existingCandidateCount: candidateCount,
        expectedCandidateMinimum,
        reason: candidateCount > 0 ? 'partial_candidate_pool' : 'candidate_pool_missing',
      });
      try {
        analyzeData = await withTimeout(
          callInternalJson('/api/analyze', { project_id: projectId }),
          65000,
          'finding_hooks timeout before local fallback',
        ) as Record<string, unknown>;
      } catch (analysisError) {
        usedLocalAnalysis = true;
        console.warn('[pipeline] analyze-primary-failed-using-local', {
          projectId,
          error: analysisError instanceof Error ? analysisError.message : String(analysisError),
        });
        analyzeData = await withTimeout(
          callInternalJson('/api/analyze', { project_id: projectId, force_local: true }),
          30000,
          'local finding_hooks fallback timeout',
        ) as Record<string, unknown>;
      }
      candidateCount = Number(analyzeData?.count ?? 0);

      if (!usedLocalAnalysis && candidateCount < expectedCandidateMinimum && analyzeData?.reason !== 'not_enough_content') {
        usedLocalAnalysis = true;
        console.warn('[pipeline] analyze-underproduced-using-local', {
          projectId,
          candidateCount,
          expectedCandidateMinimum,
        });
        await updateProjectProgress(projectId, 'finding_hooks', `Expanding reel coverage (${candidateCount}/${expectedCandidateMinimum})`);
        analyzeData = await withTimeout(
          callInternalJson('/api/analyze', { project_id: projectId, force_local: true }),
          30000,
          'local reel coverage retry timeout',
        ) as Record<string, unknown>;
        candidateCount = Number(analyzeData?.count ?? 0);
      }

      console.log('[pipeline] after analyze', { projectId, candidateCount });
      if (analyzeData?.diagnostics && typeof analyzeData.diagnostics === 'object') {
        console.log('[pipeline:analysis-diagnostics]', JSON.stringify(analyzeData.diagnostics));
      }
    }

    if (analyzeData?.reason === 'not_enough_content' || Number(analyzeData?.count ?? 0) === 0) {
      await supabase
        .from('jobs')
        .update({ status: 'done', updated_at: new Date().toISOString() })
        .eq('id', job.id);

      return NextResponse.json({ ok: true, processed: 1, project_id: projectId, reason: 'not_enough_content' });
    }

    await updateProjectProgress(projectId, 'creating_clips', 'Creating top clip candidates');

    await updateProjectProgress(projectId, 'rendering', 'Queueing reels for rendering');
    let queueData: Record<string, unknown> = {};
    try {
      queueData = await callInternalJson('/api/clips/export', { project_id: projectId });
      console.log('[pipeline] export-response', { projectId, queueData });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Pipeline step failed: /api/clips/export';
      console.error('[pipeline] export-call-failed', { projectId, message, stack: error instanceof Error ? error.stack : null });
      const alreadyQueuedLike = /duplicate|already exists|already queued|unique/i.test(message);
      if (!alreadyQueuedLike) throw error;
      queueData = { queued: 0, recovered: true };
    }

    const queued = Number(queueData?.queued ?? 0);
    const exportCounts = await getExportCounts(projectId);
    if (queued === 0 && exportCounts.done === 0 && exportCounts.active === 0) {
      throw new Error('Analysis completed, but no exportable clips were queued for rendering.');
    }

    // Rendering is intentionally not performed inside this request. A single
    // project can contain many expensive FFmpeg jobs, which previously made
    // this route exceed Vercel's request lifetime and left the project in an
    // ambiguous error/processing state. Export workers own those jobs and
    // maybeFinalizeProject durably completes the project after they settle.
    const now = new Date().toISOString();
    await supabase
      .from('projects')
      .update({
        status: 'analyzed',
        pipeline_status: 'processing',
        pipeline_stage: 'rendering',
        pipeline_stage_label: 'Rendering reels',
        pipeline_progress_percent: 72,
        pipeline_error: null,
        worker_last_seen_at: now,
        worker_last_log_message: `Queued ${queued || exportCounts.active} reels for rendering`,
        updated_at: now,
      })
      .eq('id', projectId);

    await supabase.from('jobs').update({ status: 'done', updated_at: now }).eq('id', job.id);

    return NextResponse.json({
      ok: true,
      processed: 1,
      project_id: projectId,
      waiting_for_exports: true,
      queued_exports: queued,
      export_counts: exportCounts,
      analysis_diagnostics: analyzeData?.diagnostics ?? null,
    });
  } catch (e: unknown) {
    const rawMessage = e instanceof Error ? e.message : 'Pipeline failed';
    const publicError = getPipelineErrorInfo(rawMessage);
    const message = publicError.message;
    console.error('[pipeline] failed', {
      projectId,
      raw_error: rawMessage,
      public_error: message,
      code: publicError.code,
      attempt: attemptNumber,
    });

    const { data: currentProject } = await supabase.from('projects').select('pipeline_progress_percent').eq('id', projectId).single();
    const shouldRetryPipeline = publicError.code !== 'youtube_source_blocked' && attemptNumber < PIPELINE_MAX_ATTEMPTS;

    if (shouldRetryPipeline) {
      await supabase
        .from('projects')
        .update({
          pipeline_status: 'queued',
          pipeline_stage: 'queued',
          pipeline_stage_label: 'Retrying processing',
          pipeline_progress_percent: Number(currentProject?.pipeline_progress_percent ?? 0),
          pipeline_error: null,
          worker_last_seen_at: new Date().toISOString(),
          worker_last_log_message: `Retrying processing (${attemptNumber}/${PIPELINE_MAX_ATTEMPTS})`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', projectId);

      await supabase
        .from('jobs')
        .update({
          status: 'queued',
          payload: {
            ...(job.payload ?? {}),
            retry_of_error: message,
            retry_attempt: attemptNumber,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      return NextResponse.json({
        ok: true,
        processed: 0,
        retrying: true,
        project_id: projectId,
        attempt: attemptNumber,
      });
    }

    await supabase
      .from('projects')
      .update({
        pipeline_status: 'error',
        pipeline_stage: publicError.code === 'youtube_source_blocked' ? 'source_blocked' : 'failed',
        pipeline_stage_label: publicError.stageLabel,
        pipeline_progress_percent: Number(currentProject?.pipeline_progress_percent ?? 0),
        pipeline_error: message,
        worker_last_seen_at: new Date().toISOString(),
        worker_last_log_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);

    await supabase
      .from('jobs')
      .update({
        status: 'error',
        payload: { ...(job.payload ?? {}), error: message },
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
