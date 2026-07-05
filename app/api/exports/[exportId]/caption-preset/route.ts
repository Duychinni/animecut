import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCaptionPresetById } from '@/lib/caption-presets';

export async function POST(req: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const { exportId } = await context.params;
    const { presetId } = await req.json();
    const preset = getCaptionPresetById(presetId);
    const supabase = createAdminClient();

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
        caption_preset_id: preset.id,
        caption_font_family: preset.captionFontFamily,
        caption_font_size: preset.captionFontSize,
        caption_text_color: preset.captionTextColor,
        caption_highlight_color: preset.captionHighlightColor,
        caption_stroke_color: preset.captionStrokeColor,
        caption_stroke_width: preset.captionStrokeWidth,
        caption_shadow: preset.captionShadow,
        caption_background_box: preset.captionBackgroundBox,
        caption_position: preset.captionPosition,
        caption_animation: preset.captionAnimation,
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
        caption_template: preset.caption_template,
        caption_font: preset.caption_font,
        motion_tracking: false,
        auto_reframe: true,
        reframe_mode: 'basic',
      },
      status: 'queued',
    });

    if (jobError) throw jobError;

    return NextResponse.json({ ok: true, preset });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not apply caption preset';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
