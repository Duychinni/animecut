import { NextResponse } from 'next/server';
import { cleanupTmpRootOlderThan, summarizeCleanup } from '@/lib/cleanup';
import { deleteProjectAndArtifacts } from '@/lib/data-deletion';
import { cleanupExpiredAnalysisArtifacts } from '@/lib/media-intelligence/storage';
import { ABANDONED_PROJECT_HOURS, PROJECT_RETENTION_DAYS } from '@/lib/project-retention';
import { createAdminClient } from '@/lib/supabase/admin';

type CleanupProject = {
  id: string;
  user_id: string;
  source_storage_path: string | null;
};

export async function GET(req: Request) {
  const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const now = Date.now();
    const completedCutoff = new Date(now - PROJECT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const abandonedCutoff = new Date(now - ABANDONED_PROJECT_HOURS * 60 * 60 * 1000).toISOString();

    const [finishedResult, abandonedResult] = await Promise.all([
      admin
        .from('projects')
        .select('id, user_id, source_storage_path')
        .or('status.eq.completed,pipeline_status.eq.completed')
        .lte('pipeline_completed_at', completedCutoff)
        .limit(100),
      admin
        .from('projects')
        .select('id, user_id, source_storage_path')
        .eq('status', 'created')
        .lte('created_at', abandonedCutoff)
        .limit(100),
    ]);
    if (finishedResult.error) throw finishedResult.error;
    if (abandonedResult.error) throw abandonedResult.error;

    const projects = new Map<string, CleanupProject>();
    for (const project of [...(finishedResult.data ?? []), ...(abandonedResult.data ?? [])]) {
      projects.set(project.id, project);
    }

    const failures: Array<{ project_id: string; error: string }> = [];
    let deleted = 0;
    for (const project of projects.values()) {
      try {
        await deleteProjectAndArtifacts(project);
        deleted += 1;
      } catch (error) {
        failures.push({ project_id: project.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const { data: activeProjects, error: activeError } = await admin
      .from('projects')
      .select('id')
      .in('pipeline_status', ['queued', 'processing']);
    if (activeError) throw activeError;
    const protectedProjectIds = new Set((activeProjects ?? []).map((project) => String(project.id)));
    const analysis = await cleanupExpiredAnalysisArtifacts(500);
    const temp = summarizeCleanup(await cleanupTmpRootOlderThan(24, protectedProjectIds));
    console.log('[cleanup] retention', { deleted, failures, analysis, temp });
    return NextResponse.json({ ok: failures.length === 0, deleted, failures, analysis, temp });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Retention cleanup failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
