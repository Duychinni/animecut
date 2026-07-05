import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

type ProjectStatus = 'created' | 'transcribed' | 'analyzed' | 'completed' | string;

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

function targetClipCountForDuration(totalSeconds: number) {
  const minutes = totalSeconds / 60;
  if (minutes <= 5) return 5;
  if (minutes <= 15) return 7;
  if (minutes <= 30) return 10;
  if (minutes <= 60) return 15;
  if (minutes <= 120) return 20;
  return 25;
}

function computeProgress(status: ProjectStatus, doneExports: number, targetCount: number, elapsedSeconds: number) {
  const safeTarget = Math.max(1, targetCount);

  if (status === 'completed') return 100;

  if (status === 'created') {
    const early = Math.min(42, 10 + Math.floor(elapsedSeconds / 4));
    return early;
  }

  if (status === 'transcribed') {
    const mid = Math.min(62, 45 + Math.floor(elapsedSeconds / 6));
    return mid;
  }

  if (status === 'analyzed') {
    return Math.min(99, Math.round(65 + (doneExports / safeTarget) * 35));
  }

  return 5;
}

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const [{ data: project, error: pErr }, { data: exportsRows, error: eErr }, { count: candidateCount, error: cErr }, { data: transcriptRow }] = await Promise.all([
      supabase
        .from('projects')
        .select('id, title, status, source_type, source_url, created_at, updated_at')
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
    const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length;
    const failedExports = rows.filter((r) => r.status === 'error').length;

    const analyzedCandidates = Math.max(0, Number(candidateCount ?? 0));
    const transcriptSegments = Array.isArray(transcriptRow?.segments_json) ? (transcriptRow?.segments_json as { end?: number }[]) : [];
    const totalSeconds = transcriptSegments.reduce((acc, s) => Math.max(acc, Number(s?.end ?? 0)), 0);
    const desiredTarget = targetClipCountForDuration(totalSeconds);
    const targetCount = Math.max(1, desiredTarget);

    const now = Date.now();
    const createdAtMs = project.created_at ? new Date(project.created_at).getTime() : now;
    const elapsedSeconds = Math.max(0, Math.round((now - createdAtMs) / 1000));

    const isReallyCompleted =
      activeExports === 0 &&
      (doneExports >= targetCount || doneExports + failedExports >= targetCount || (rows.length > 0 && doneExports === rows.length));

    const effectiveStatus = isReallyCompleted ? 'completed' : (project.status as string);
    const progressPercent = isReallyCompleted ? 100 : computeProgress(effectiveStatus, doneExports, targetCount, elapsedSeconds);

    // Rough ETA for UX only.
    let etaSeconds: number | null = null;
    if (effectiveStatus === 'created') etaSeconds = 180;
    else if (effectiveStatus === 'transcribed') etaSeconds = 100;
    else if (effectiveStatus === 'analyzed') {
      const remaining = Math.max(0, targetCount - doneExports);
      etaSeconds = remaining * 45;
    } else if (effectiveStatus === 'completed') etaSeconds = 0;

    if (isReallyCompleted && project.status !== 'completed') {
      await supabase.from('projects').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', projectId);
    }

    const sourceUrl = typeof project.source_url === 'string' ? project.source_url : null;
    const youtubeId = sourceUrl ? parseYouTubeId(sourceUrl) : null;
    const thumbnailUrl = youtubeId ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` : null;

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
