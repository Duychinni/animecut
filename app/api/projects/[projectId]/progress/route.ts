import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getTargetClipCount } from '@/lib/clip-policy';

type ProjectStatus = 'created' | 'transcribed' | 'analyzed' | 'completed' | string;
type PipelineStatus = 'idle' | 'queued' | 'processing' | 'completed' | 'error' | string;

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
  elapsedSeconds: number;
  hasTranscript: boolean;
  analyzedCandidates: number;
  doneExports: number;
  activeExports: number;
  targetCount: number;
}) {
  const { status, pipelineStatus, elapsedSeconds, hasTranscript, analyzedCandidates, doneExports, activeExports, targetCount } = params;
  const safeTarget = Math.max(1, targetCount);

  if ((status === 'completed' || pipelineStatus === 'completed') && activeExports === 0 && doneExports >= safeTarget) return 100;
  if (pipelineStatus === 'error') return Math.max(5, Math.min(95, doneExports > 0 ? 70 : 12));

  if (!hasTranscript) {
    if (pipelineStatus === 'queued') return 8;
    if (pipelineStatus === 'processing') return Math.min(34, 10 + Math.floor(elapsedSeconds / 3));
    return Math.min(24, 6 + Math.floor(elapsedSeconds / 4));
  }

  if (hasTranscript && analyzedCandidates === 0) {
    return Math.min(64, 38 + Math.floor(elapsedSeconds / 8));
  }

  const exportProgress = doneExports / safeTarget;
  const activeBoost = activeExports > 0 ? 4 : 0;
  return Math.min(99, Math.round(68 + exportProgress * 28 + activeBoost));
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

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const [{ data: project, error: pErr }, { data: exportsRows, error: eErr }, { count: candidateCount, error: cErr }, { data: transcriptRow }] = await Promise.all([
      supabase
        .from('projects')
        .select('id, title, status, pipeline_status, pipeline_stage, pipeline_stage_label, pipeline_progress_percent, worker_last_seen_at, worker_last_log_message, pipeline_error, source_type, source_url, source_thumbnail_url, source_duration_seconds, created_at, updated_at')
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

    const rows = exportsRows ?? [];
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

    const isReallyCompleted =
      activeExports === 0 && doneExports > 0 && (projectMarkedCompleted || doneExports >= targetCount);

    const projectNeedsExportCompletion = projectMarkedCompleted && activeExports > 0;
    const effectiveStatus = isReallyCompleted ? 'completed' : projectNeedsExportCompletion ? 'analyzed' : (project.status as string);
    let pipelineStatus = ((project as { pipeline_status?: string | null }).pipeline_status ?? 'idle') as string;
    if (projectNeedsExportCompletion) {
      pipelineStatus = 'processing';
    }
    const hasTranscript = transcriptSegments.length > 0;
    const explicitPercent = Number((project as { pipeline_progress_percent?: number | null }).pipeline_progress_percent ?? NaN);
    const lastSeenRaw = (project as { worker_last_seen_at?: string | null }).worker_last_seen_at ?? null;
    const lastSeenMs = lastSeenRaw ? new Date(lastSeenRaw).getTime() : 0;
    const staleWorker = !isReallyCompleted && pipelineStatus === 'processing' && lastSeenMs > 0 && (Date.now() - lastSeenMs) > 5 * 60 * 1000;
    if (staleWorker) {
      pipelineStatus = 'error';
    }
    const progressPercent = isReallyCompleted
      ? 100
      : activeExports > 0 || !Number.isFinite(explicitPercent)
        ? computeProgress({
            status: effectiveStatus,
            pipelineStatus,
            elapsedSeconds,
            hasTranscript,
            analyzedCandidates,
            doneExports,
            activeExports,
            targetCount,
          })
        : explicitPercent;

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

    if (isReallyCompleted && project.status !== 'completed') {
      await supabase.from('projects').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', projectId);
    }

    const sourceUrl = typeof project.source_url === 'string' ? project.source_url : null;
    const storedThumbnailUrl = typeof (project as { source_thumbnail_url?: string | null }).source_thumbnail_url === 'string'
      ? (project as { source_thumbnail_url?: string | null }).source_thumbnail_url
      : null;
    const youtubeId = sourceUrl ? parseYouTubeId(sourceUrl) : null;
    const thumbnailUrl = storedThumbnailUrl || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg` : null);

    console.log('[projects/progress] counts', {
      project_id: projectId,
      transcript_seconds: totalSeconds,
      analyzed_candidates: analyzedCandidates,
      done_exports: doneExports,
      active_exports: activeExports,
      failed_exports: failedExports,
      target_exports: targetCount,
    });

    return NextResponse.json({
      ok: true,
      project: {
        id: project.id,
        title: project.title,
        status: effectiveStatus,
        pipeline_status: pipelineStatus,
        pipeline_stage: (project as { pipeline_stage?: string | null }).pipeline_stage ?? null,
        pipeline_stage_label: staleWorker ? 'Worker heartbeat expired' : ((project as { pipeline_stage_label?: string | null }).pipeline_stage_label ?? null),
        worker_last_seen_at: lastSeenRaw,
        worker_last_log_message: (project as { worker_last_log_message?: string | null }).worker_last_log_message ?? null,
        pipeline_error: staleWorker ? 'Worker heartbeat expired after 5 minutes without progress update.' : ((project as { pipeline_error?: string | null }).pipeline_error ?? null),
        source_type: project.source_type,
        source_url: sourceUrl,
        thumbnail_url: thumbnailUrl,
        created_at: project.created_at,
        updated_at: project.updated_at,
      },
      progress: {
        percent: Math.max(0, Math.min(100, progressPercent)),
        done_exports: doneExports,
        active_exports: activeExports,
        target_exports: targetCount,
        elapsed_seconds: elapsedSeconds,
        eta_seconds: etaSeconds,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
