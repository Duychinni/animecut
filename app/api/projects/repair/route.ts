import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

type ExportRepairRow = {
  id?: string | null;
  status?: string | null;
  output_storage_path?: string | null;
  error_message?: string | null;
  updated_at?: string | null;
};

function isRetryableRenderError(message: string | null | undefined) {
  return /render failed|ffmpeg|video filter|filter not found|required video filter|retry the export|corrupted/i.test(message ?? '');
}

function isStaleActiveExport(row: ExportRepairRow, maxAgeMinutes = 15) {
  if (row.status !== 'queued' && row.status !== 'processing') return false;
  const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  if (!updatedAt) return true;
  return Date.now() - updatedAt > maxAgeMinutes * 60 * 1000;
}

async function ensureExportJob(admin: ReturnType<typeof createAdminClient>, projectId: string, exportId: string) {
  const { data: existingJob, error: jobError } = await admin
    .from('jobs')
    .select('id')
    .eq('type', 'export')
    .in('status', ['queued', 'processing'])
    .contains('payload', { export_id: exportId })
    .maybeSingle();

  if (jobError) throw jobError;
  if (existingJob?.id) return false;

  const { error } = await admin.from('jobs').insert({
    project_id: projectId,
    type: 'export',
    payload: { export_id: exportId, repair: true },
    status: 'queued',
  });

  if (error) throw error;
  return true;
}

export async function POST() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();
    const { data: projects, error } = await admin
      .from('projects')
      .select('id, user_id, status, pipeline_status, exports(id, status, output_storage_path, error_message, updated_at)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    let repaired = 0;
    let requeuedExports = 0;
    let ensuredJobs = 0;

    for (const project of projects ?? []) {
      const rows = Array.isArray(project.exports)
        ? (project.exports as ExportRepairRow[])
        : [];
      const projectAlreadyCompleted = project.status === 'completed' || project.pipeline_status === 'completed';
      const activeRows = rows.filter((r) => r.id && (r.status === 'queued' || r.status === 'processing'));
      const readyExports = rows.filter((r) => typeof r.output_storage_path === 'string' && r.output_storage_path.length > 0).length;
      const staleActiveRows = activeRows.filter((r) => isStaleActiveExport(r));
      const shouldRetireActiveRows = readyExports > 0 && (projectAlreadyCompleted || (activeRows.length > 0 && staleActiveRows.length === activeRows.length));

      if (shouldRetireActiveRows) {
        await admin
          .from('projects')
          .update({
            status: 'completed',
            pipeline_status: 'completed',
            pipeline_error: null,
            pipeline_completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', project.id)
          .eq('user_id', user.id);

        repaired += 1;
        continue;
      }

      const retryableErrors = projectAlreadyCompleted
        ? []
        : rows.filter((r) => r.id && r.status === 'error' && isRetryableRenderError(r.error_message));

      if (retryableErrors.length) {
        const ids = retryableErrors.map((r) => String(r.id));
        const { error: requeueError } = await admin
          .from('exports')
          .update({
            status: 'queued',
            output_storage_path: null,
            error_message: 'Requeued after renderer repair.',
            updated_at: new Date().toISOString(),
          })
          .in('id', ids);

        if (requeueError) throw requeueError;

        for (const exportId of ids) {
          const created = await ensureExportJob(admin, String(project.id), exportId);
          if (created) ensuredJobs += 1;
        }

        requeuedExports += ids.length;
      }

      const queuedRows = projectAlreadyCompleted ? [] : rows.filter((r) => r.id && r.status === 'queued');
      for (const row of queuedRows) {
        const created = await ensureExportJob(admin, String(project.id), String(row.id));
        if (created) ensuredJobs += 1;
      }

      const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length + retryableErrors.length;

      if (readyExports > 0 && activeExports === 0 && (project.status !== 'completed' || project.pipeline_status !== 'completed')) {
        await admin
          .from('projects')
          .update({
            status: 'completed',
            pipeline_status: 'completed',
            pipeline_error: null,
            pipeline_completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', project.id)
          .eq('user_id', user.id);

        await admin
          .from('exports')
          .update({ status: 'done', error_message: null, updated_at: new Date().toISOString() })
          .eq('project_id', project.id)
          .not('output_storage_path', 'is', null);

        repaired += 1;
      }
    }

    return NextResponse.json({ ok: true, repaired, requeuedExports, ensuredJobs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Repair failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
