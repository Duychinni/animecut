import { NextResponse } from 'next/server';
import { clipEditorErrorMessage, isMissingEditColumnError, loadClipEditData, sanitizeClipEditPayload } from '@/lib/clip-edit-data';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

async function getAuthorizedClip(clipId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { user: null, data: null };
  const data = await loadClipEditData(clipId, user.id);
  return { user, data };
}

export async function GET(_req: Request, context: { params: Promise<{ clipId: string }> }) {
  try {
    const { clipId } = await context.params;
    const { user, data } = await getAuthorizedClip(clipId);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!data) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
    return NextResponse.json(data);
  } catch (error) {
    const detail = clipEditorErrorMessage(error);
    console.error('[clip-editor] load failed', { detail, error });
    return NextResponse.json({ error: 'Could not load clip editor', code: 'clip_editor_load_failed', detail }, { status: 400 });
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ clipId: string }> }) {
  try {
    const { clipId } = await context.params;
    const { user, data } = await getAuthorizedClip(clipId);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!data) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });

    const body = await req.json();
    const settings = sanitizeClipEditPayload(body?.settings ?? body, data);
    const admin = createAdminClient();
    const { error } = await admin
      .from('exports')
      .update({
        clip_edit_settings: settings,
        caption_preset_id: settings.caption_preset_id,
        edit_status: 'draft',
        updated_at: new Date().toISOString(),
      })
      .eq('id', clipId);

    if (error) {
      if (isMissingEditColumnError(error)) {
        return NextResponse.json({
          error: 'Clip editor storage is not ready yet',
          code: 'clip_edit_columns_missing',
          detail: clipEditorErrorMessage(error),
        }, { status: 409 });
      }
      throw error;
    }

    const refreshed = await loadClipEditData(clipId, user.id);
    if (!refreshed) return NextResponse.json({ error: 'Clip not found after saving edits' }, { status: 404 });
    return NextResponse.json(refreshed);
  } catch (error) {
    const detail = clipEditorErrorMessage(error, 'Could not save clip edits');
    console.error('[clip-editor] save failed', { detail, error });
    return NextResponse.json({ error: 'Could not save clip edits', code: 'clip_editor_save_failed', detail }, { status: 400 });
  }
}
