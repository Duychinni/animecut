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

function computeProgress(status: ProjectStatus, doneExports: number, targetCount: number) {
  const safeTarget = Math.max(1, targetCount);

  if (status === 'completed') return 100;
  if (status === 'analyzed') {
    return Math.min(99, Math.round(65 + (doneExports / safeTarget) * 35));
  }
  if (status === 'transcribed') return 55;
  if (status === 'created') return 10;
  return 5;
}

export async function GET(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const [{ data: project, error: pErr }, { data: exportsRows, error: eErr }, { count: candidateCount, error: cErr }] = await Promise.all([
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
    ]);

    if (pErr || !project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (eErr) return NextResponse.json({ error: eErr.message }, { status: 400 });
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 });

    const rows = exportsRows ?? [];
    const doneExports = rows.filter((r) => r.status === 'done').length;
    const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length;
    const failedExports = rows.filter((r) => r.status === 'error').length;

    const analyzedCandidates = Math.max(0, Number(candidateCount ?? 0));
    const dynamicTarget = Math.max(1, Math.min(10, analyzedCandidates || 0));
    const targetCount = dynamicTarget || Math.max(1, Math.min(10, rows.length || 1));

    const isReallyCompleted =
      activeExports === 0 &&
      (doneExports >= targetCount || doneExports + failedExports >= targetCount || (rows.length > 0 && doneExports === rows.length));

    const effectiveStatus = isReallyCompleted ? 'completed' : (project.status as string);
    const progressPercent = isReallyCompleted ? 100 : computeProgress(effectiveStatus, doneExports, targetCount);

    const now = Date.now();
    const createdAtMs = project.created_at ? new Date(project.created_at).getTime() : now;
    const elapsedSeconds = Math.max(0, Math.round((now - createdAtMs) / 1000));

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
