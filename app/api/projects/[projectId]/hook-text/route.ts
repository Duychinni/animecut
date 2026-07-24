import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

type ProjectExport = {
  id: string;
  status: string | null;
  output_storage_path: string | null;
  edit_status: string | null;
};

async function updateProjectHookText(
  context: { params: Promise<{ projectId: string }> },
  enabled: boolean,
) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (projectError) throw projectError;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const admin = createAdminClient();
    const { data: exportRows, error: exportsError } = await admin
      .from('exports')
      .select('id, status, output_storage_path, edit_status, hook_text_enabled')
      .eq('project_id', projectId);

    if (exportsError) throw exportsError;

    const exportsToRender = ((exportRows ?? []) as Array<ProjectExport & { hook_text_enabled: boolean | null }>).filter((row) =>
      row.status !== 'error'
      && row.edit_status !== 'rendering'
      && row.hook_text_enabled !== enabled
      && typeof row.output_storage_path === 'string'
      && row.output_storage_path.length > 0
      && !row.output_storage_path.startsWith('mock://')
    );
    const exportIds = exportsToRender.map((row) => row.id);

    if (!exportIds.length) {
      return NextResponse.json({ ok: true, queued: 0 });
    }

    const { error: updateError } = await admin
      .from('exports')
      .update({
        hook_text_enabled: enabled,
        edit_status: 'rendering',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .in('id', exportIds);

    if (updateError) throw updateError;

    const { error: jobsError } = await admin.from('jobs').insert(exportIds.map((exportId) => ({
      project_id: projectId,
      type: 'export',
      status: 'queued',
      payload: {
        export_id: exportId,
        edit_rerender: true,
        fast_edit_render: false,
        hook_text_enabled: enabled,
      },
    })));

    if (jobsError) {
      await admin
        .from('exports')
        .update({
          hook_text_enabled: !enabled,
          edit_status: 'error',
          error_message: `Could not queue hook ${enabled ? 'restore' : 'removal'}.`,
        })
        .in('id', exportIds);
      throw jobsError;
    }

    return NextResponse.json({ ok: true, queued: exportIds.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : `Could not ${enabled ? 'restore' : 'remove'} hook text`;
    console.error('[projects/hook-text] bulk update failed', { message, error });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ projectId: string }> }) {
  return updateProjectHookText(context, false);
}

export async function POST(_: Request, context: { params: Promise<{ projectId: string }> }) {
  return updateProjectHookText(context, true);
}
