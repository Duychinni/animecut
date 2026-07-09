import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const { exportId } = await context.params;
    const { preset } = await req.json();
    const supabase = createAdminClient();

    const allowed = new Set(['auto', 'tight', 'left', 'center', 'right']);
    const chosen = typeof preset === 'string' && allowed.has(preset) ? preset : 'auto';

    const { data: existing, error: existingError } = await supabase
      .from('exports')
      .select('id, project_id, clip_candidate_id')
      .eq('id', exportId)
      .single();

    if (existingError || !existing) {
      return NextResponse.json({ error: 'Export not found' }, { status: 404 });
    }

    const { error: updateError } = await supabase
      .from('exports')
      .update({
        status: 'queued',
        error_message: null,
        output_storage_path: null,
      })
      .eq('id', exportId);

    if (updateError) throw updateError;

    const { error: jobError } = await supabase.from('jobs').insert({
      project_id: existing.project_id,
      type: 'export',
      payload: {
        export_id: exportId,
        captions_enabled: true,
        motion_tracking: false,
        auto_reframe: true,
        reframe_mode: 'smart',
        reframe_preset: chosen,
        hook_text_enabled: true,
      },
      status: 'queued',
    });

    if (jobError) throw jobError;

    return NextResponse.json({ ok: true, preset: chosen });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not apply reframe preset';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
