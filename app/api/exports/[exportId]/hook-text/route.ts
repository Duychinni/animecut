import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { generateHookText } from '@/lib/hook-text';
import { getCaptionPresetById } from '@/lib/caption-presets';

const HOOK_TEXT_OVERLAY_ENABLED = process.env.ENABLE_HOOK_TEXT_OVERLAY !== 'false';

export async function POST(req: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const { exportId } = await context.params;
    const body = await req.json().catch(() => ({}));
    const enabled = HOOK_TEXT_OVERLAY_ENABLED && body?.enabled !== false;
    const manualText = typeof body?.hookText === 'string' ? body.hookText.trim() : '';
    const supabase = createAdminClient();

    const { data: existing, error: existingError } = await supabase
      .from('exports')
      .select('id, project_id, clip_candidate_id, caption_preset_id')
      .eq('id', exportId)
      .single();

    if (existingError || !existing) {
      return NextResponse.json({ error: 'Export not found' }, { status: 404 });
    }
    const preset = getCaptionPresetById(typeof existing.caption_preset_id === 'string' ? existing.caption_preset_id : undefined);

    const [{ data: clip }, { data: transcript }] = await Promise.all([
      supabase
        .from('clip_candidates')
        .select('title, start_sec, end_sec')
        .eq('id', existing.clip_candidate_id)
        .single(),
      supabase
        .from('transcripts')
        .select('segments_json')
        .eq('project_id', existing.project_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
    ]);

    const generated = manualText || generateHookText({
      clipTitle: clip?.title ?? null,
      transcriptSegments: Array.isArray(transcript?.segments_json) ? transcript.segments_json : [],
      startSec: Number(clip?.start_sec ?? 0),
      endSec: Number(clip?.end_sec ?? 0),
    }) || null;

    const { error: updateError } = await supabase
      .from('exports')
      .update({
        hook_text_enabled: enabled,
        hook_text: generated,
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
        caption_preset_id: preset.id,
        caption_template: preset.caption_template,
        caption_font: preset.caption_font,
        motion_tracking: false,
        auto_reframe: true,
        reframe_mode: 'smart',
        hook_text_enabled: enabled,
        hook_text: generated,
      },
      status: 'queued',
    });

    if (jobError) throw jobError;

    return NextResponse.json({ ok: true, enabled, hookText: generated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not update hook text';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
