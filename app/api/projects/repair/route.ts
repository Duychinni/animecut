import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { DEFAULT_CAPTION_PRESET_ID, getCaptionPresetById } from '@/lib/caption-presets';

type ExportRepairRow = {
  id?: string | null;
  status?: string | null;
  output_storage_path?: string | null;
  error_message?: string | null;
  updated_at?: string | null;
  caption_font_family?: string | null;
  caption_stroke_width?: number | null;
};

function isRetryableRenderError(message: string | null | undefined) {
  return /render failed|ffmpeg|video filter|filter not found|required video filter|retry the export|corrupted/i.test(message ?? '');
}

function usesCurrentCaptionStyle(row: ExportRepairRow, preset: ReturnType<typeof getCaptionPresetById>) {
  return row.caption_font_family === preset.captionFontFamily
    && Number(row.caption_stroke_width ?? 0) >= preset.captionStrokeWidth;
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
      .select('id, user_id, status, pipeline_status, exports(id, status, output_storage_path, error_message, updated_at, caption_font_family, caption_stroke_width)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    let repaired = 0;
    let requeuedExports = 0;
    let ensuredJobs = 0;
    const captionPreset = getCaptionPresetById(DEFAULT_CAPTION_PRESET_ID);

    for (const project of projects ?? []) {
      const rows = Array.isArray(project.exports)
        ? (project.exports as ExportRepairRow[])
        : [];
      const projectAlreadyCompleted = project.status === 'completed' || project.pipeline_status === 'completed';
      const activeRows = rows.filter((r) => r.id && (r.status === 'queued' || r.status === 'processing'));
      const readyExports = rows.filter((r) => typeof r.output_storage_path === 'string' && r.output_storage_path.length > 0).length;
      const frozenCompletedProject = projectAlreadyCompleted && readyExports > 0 && activeRows.length === 0;
      let requeuedOldStyle = false;

      const oldStyleDoneRows = rows.filter((r) => (
        r.id
        && r.status === 'done'
        && typeof r.output_storage_path === 'string'
        && r.output_storage_path.length > 0
        && !usesCurrentCaptionStyle(r, captionPreset)
      ));

      if (oldStyleDoneRows.length && (!projectAlreadyCompleted || activeRows.length > 0)) {
        const ids = oldStyleDoneRows.map((r) => String(r.id));
        const { error: staleStyleError } = await admin
          .from('exports')
          .update({
            status: 'queued',
            output_storage_path: null,
            error_message: 'Requeued to normalize caption style.',
            caption_preset_id: captionPreset.id,
            caption_font_family: captionPreset.captionFontFamily,
            caption_font_size: captionPreset.captionFontSize,
            caption_text_color: captionPreset.captionTextColor,
            caption_highlight_color: captionPreset.captionHighlightColor,
            caption_stroke_color: captionPreset.captionStrokeColor,
            caption_stroke_width: captionPreset.captionStrokeWidth,
            caption_shadow: captionPreset.captionShadow,
            caption_background_box: captionPreset.captionBackgroundBox,
            caption_position: captionPreset.captionPosition,
            caption_animation: captionPreset.captionAnimation,
            updated_at: new Date().toISOString(),
          })
          .in('id', ids);

        if (staleStyleError) throw staleStyleError;

        for (const exportId of ids) {
          const created = await ensureExportJob(admin, String(project.id), exportId);
          if (created) ensuredJobs += 1;
        }

        requeuedExports += ids.length;
        requeuedOldStyle = true;
      }

      const retryableErrors = frozenCompletedProject
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

      const queuedRows = frozenCompletedProject ? [] : rows.filter((r) => r.id && r.status === 'queued');
      for (const row of queuedRows) {
        const created = await ensureExportJob(admin, String(project.id), String(row.id));
        if (created) ensuredJobs += 1;
      }

      const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length + retryableErrors.length;

      if (!requeuedOldStyle && projectAlreadyCompleted && readyExports > 0 && activeExports === 0 && (project.status !== 'completed' || project.pipeline_status !== 'completed')) {
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
