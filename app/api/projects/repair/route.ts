import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

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
      .select('id, user_id, status, pipeline_status, exports(status, output_storage_path)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    let repaired = 0;

    for (const project of projects ?? []) {
      const rows = Array.isArray(project.exports)
        ? (project.exports as Array<{ status?: string | null; output_storage_path?: string | null }>)
        : [];
      const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length;
      const readyExports = rows.filter((r) => typeof r.output_storage_path === 'string' && r.output_storage_path.length > 0).length;

      if (readyExports > 0 && (project.status !== 'completed' || project.pipeline_status !== 'completed' || activeExports > 0)) {
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

    return NextResponse.json({ ok: true, repaired });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Repair failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
