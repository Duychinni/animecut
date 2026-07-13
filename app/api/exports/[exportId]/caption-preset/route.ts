import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getCaptionPresetById } from '@/lib/caption-presets';
import { generateHookText } from '@/lib/hook-text';

const HOOK_TEXT_OVERLAY_ENABLED = process.env.ENABLE_HOOK_TEXT_OVERLAY !== 'false';

export async function POST(req: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const { exportId } = await context.params;
    const { presetId, reframePreset, hookTextEnabled } = await req.json();
    const preset = getCaptionPresetById(presetId);
    const supabase = createAdminClient();
    const allowedReframePresets = new Set(['auto', 'tight', 'left', 'center', 'right']);
    const chosenReframePreset = typeof reframePreset === 'string' && allowedReframePresets.has(reframePreset) ? reframePreset : 'auto';
    const hookEnabled = HOOK_TEXT_OVERLAY_ENABLED && hookTextEnabled !== false;

    const { data: existing, error: existingError } = await supabase
      .from('exports')
      .select('id, project_id, clip_candidate_id')
      .eq('id', exportId)
      .single();

    if (existingError || !existing) {
      return NextResponse.json({ error: 'Export not found' }, { status: 404 });
    }

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

    const hookText = hookEnabled
      ? generateHookText({
          clipTitle: clip?.title ?? null,
          transcriptSegments: Array.isArray(transcript?.segments_json) ? transcript.segments_json : [],
          startSec: Number(clip?.start_sec ?? 0),
          endSec: Number(clip?.end_sec ?? 0),
        })
      : null;

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
        hook_text_enabled: hookEnabled,
        hook_text: hookText,
        status: 'queued',
        error_message: null,
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
        reframe_preset: chosenReframePreset,
        hook_text_enabled: hookEnabled,
        hook_text: hookText,
      },
      status: 'queued',
    });

    if (jobError) throw jobError;

    return NextResponse.json({ ok: true, preset, reframePreset: chosenReframePreset, hookText });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not apply caption preset';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
