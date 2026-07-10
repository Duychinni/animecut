import { NextResponse } from 'next/server';
import { loadClipEditData, sanitizeClipEditPayload } from '@/lib/clip-edit-data';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: Request, context: { params: Promise<{ clipId: string }> }) {
  try {
    const { clipId } = await context.params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const current = await loadClipEditData(clipId, user.id);
    if (!current) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });

    const body = await req.json().catch(() => ({}));
    const settings = sanitizeClipEditPayload(body?.settings ?? current.settings, current);
    const admin = createAdminClient();

    const { error: updateError } = await admin
      .from('exports')
      .update({
        clip_edit_settings: settings,
        caption_preset_id: settings.caption_preset_id,
        edit_status: 'rendering',
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', clipId);

    if (updateError) throw updateError;

    const { error: jobError } = await admin.from('jobs').insert({
      project_id: current.project.id,
      type: 'export',
      status: 'queued',
      payload: {
        export_id: clipId,
        edit_rerender: true,
        captions_enabled: settings.captions_enabled,
        caption_preset_id: settings.caption_preset_id,
        auto_reframe: settings.framing_mode === 'auto',
        reframe_mode: 'smart',
        reframe_preset: 'auto',
        motion_tracking: false,
      },
    });

    if (jobError) throw jobError;

    const refreshed = await loadClipEditData(clipId, user.id);
    if (!refreshed) return NextResponse.json({ error: 'Clip not found after queueing render' }, { status: 404 });
    return NextResponse.json({ ok: true, ...refreshed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not queue clip re-render';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
