import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTargetClipCount } from '@/lib/clip-policy';
import { getCaptionPresetById } from '@/lib/caption-presets';

type SupabaseAdminClient = ReturnType<typeof createAdminClient>;

function serializeUnknownError(error: unknown) {
  if (error instanceof Error) {
    return {
      type: error.constructor?.name ?? 'Error',
      message: error.message,
      stack: error.stack ?? null,
    };
  }

  if (typeof error === 'string') {
    return {
      type: 'string',
      message: error,
      stack: null,
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      type: record.constructor && typeof record.constructor === 'function' ? (record.constructor as { name?: string }).name ?? 'object' : 'object',
      message:
        typeof record.message === 'string'
          ? record.message
          : typeof record.error === 'string'
            ? record.error
            : JSON.stringify(record),
      details: record,
      stack: typeof record.stack === 'string' ? record.stack : null,
    };
  }

  return {
    type: typeof error,
    message: String(error),
    stack: null,
  };
}

function normalizeReframeMode(raw: unknown, fallback: 'off' | 'basic' | 'smart'): 'off' | 'basic' | 'smart' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'basic' || value === 'smart') return value;
  return fallback;
}

function getDefaultReframeMode() {
  return normalizeReframeMode(process.env.EXPORT_DEFAULT_REFRAME_MODE, 'smart');
}

function normalizeHookText(raw: unknown) {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\-:\s]+/, '')
    .replace(/["']+$/g, '')
    .replace(/[.,;:\s]+$/g, '')
    .trim();
  return cleaned || null;
}

function readOptionalField(row: unknown, key: string) {
  if (!row || typeof row !== 'object') return undefined;
  return (row as Record<string, unknown>)[key];
}

function isMissingHookTextColumnError(error: unknown) {
  const serialized = serializeUnknownError(error);
  const details = 'details' in serialized ? serialized.details : null;
  const text = `${serialized.type} ${serialized.message} ${JSON.stringify(details)}`;
  return /hook_text/i.test(text) && /(column|schema cache|could not find|PGRST204|42703)/i.test(text);
}

async function selectTopCandidates(supabase: SupabaseAdminClient, projectId: string) {
  const withHookText = await supabase
    .from('clip_candidates')
    .select('id, overall_score, title, hook_text, start_sec, end_sec')
    .eq('project_id', projectId)
    .order('overall_score', { ascending: false })
    .limit(100);

  if (!withHookText.error || !isMissingHookTextColumnError(withHookText.error)) return withHookText;

  console.warn('[clips/export] hook_text column missing; selecting candidates without hook_text');
  return supabase
    .from('clip_candidates')
    .select('id, overall_score, title, start_sec, end_sec')
    .eq('project_id', projectId)
    .order('overall_score', { ascending: false })
    .limit(100);
}

async function selectSelectedCandidateHooks(supabase: SupabaseAdminClient, projectId: string, selectedIds: string[]) {
  const withHookText = await supabase
    .from('clip_candidates')
    .select('id, title, hook_text')
    .eq('project_id', projectId)
    .in('id', selectedIds);

  if (!withHookText.error || !isMissingHookTextColumnError(withHookText.error)) return withHookText;

  console.warn('[clips/export] hook_text column missing; selecting selected candidates without hook_text');
  return supabase
    .from('clip_candidates')
    .select('id, title')
    .eq('project_id', projectId)
    .in('id', selectedIds);
}

export async function POST(req: Request) {
  try {
    const {
      project_id,
      candidate_ids,
      target_count,
      captions_enabled,
      caption_preset_id,
      caption_template,
      caption_font,
      motion_tracking,
      auto_reframe,
      reframe_mode,
    } = await req.json();
    const supabase = createAdminClient();

    const captionPreset = getCaptionPresetById(typeof caption_preset_id === 'string' ? caption_preset_id : undefined);
    const captionsEnabled = captions_enabled !== false;
    const captionTemplate = (caption_template ?? captionPreset.caption_template) as
      | 'clean'
      | 'bold'
      | 'viral'
      | 'karaoke'
      | 'cinematic'
      | 'rage'
      | 'minimal'
      | 'capcut';
    const captionFont = (caption_font ?? captionPreset.caption_font) as 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';
    // Speed-first default: motion tracking is expensive (extra ffmpeg analysis pass).
    // Enable explicitly per request when needed.
    const motionTracking = motion_tracking === true;
    const autoReframe = auto_reframe !== false;
    const reframeMode = normalizeReframeMode(reframe_mode, getDefaultReframeMode());

    const explicitTargetCount = Number(target_count ?? 0);
    let targetCount = Number.isFinite(explicitTargetCount) && explicitTargetCount > 0
      ? Math.max(1, Math.floor(explicitTargetCount))
      : 0;
    let selectedIds = Array.isArray(candidate_ids) ? (candidate_ids as string[]) : [];
    let blockedCount = 0;
    let candidateHookText = new Map<string, string>();

    const { data: projectRow } = await supabase
      .from('projects')
      .select('pipeline_status, pipeline_error')
      .eq('id', project_id)
      .maybeSingle();

    if (projectRow?.pipeline_error === 'not_enough_content') {
      return NextResponse.json({ ok: true, queued: 0, exports: [], reason: 'not_enough_content', counts: { selected_before_queue: 0, resolved_target_count: targetCount } });
    }

    if (!selectedIds.length) {
      const [{ data: existingExports, error: exErr }, { data: topCandidates, error: cErr }] = await Promise.all([
        supabase
          .from('exports')
          .select('clip_candidate_id, status')
          .eq('project_id', project_id),
        selectTopCandidates(supabase, project_id),
      ]);

      if (exErr) throw exErr;
      if (cErr) throw cErr;

      if (!(targetCount > 0)) {
        const { data: transcriptRow } = await supabase
          .from('transcripts')
          .select('segments_json')
          .eq('project_id', project_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        const segments = Array.isArray(transcriptRow?.segments_json) ? (transcriptRow?.segments_json as { end?: number }[]) : [];
        const totalSeconds = segments.reduce((acc, s) => Math.max(acc, Number(s?.end ?? 0)), 0);
        const desired = getTargetClipCount(totalSeconds);
        targetCount = Math.max(1, Math.min(desired, (topCandidates ?? []).length || desired));
      }

      const doneCount = (existingExports ?? []).filter((r) => r.status === 'done').length;
      const inFlightCount = (existingExports ?? []).filter((r) => r.status === 'queued' || r.status === 'processing').length;
      const needed = targetCount > 0 ? Math.max(0, targetCount - doneCount - inFlightCount) : 0;

      const blockedCandidateIds = new Set(
        (existingExports ?? [])
          .filter((r) => r.status === 'done' || r.status === 'queued' || r.status === 'processing')
          .map((r) => (r.clip_candidate_id ? String(r.clip_candidate_id) : null))
          .filter((v): v is string => Boolean(v)),
      );
      blockedCount = blockedCandidateIds.size;

      const strongCandidates = (topCandidates ?? []).filter((row) => Number(row.overall_score ?? 0) >= 7.0);
      const candidatePool = strongCandidates.length ? strongCandidates : (topCandidates ?? []);

      const durationFiltered = candidatePool.filter((row) => {
        const duration = Math.max(0, Number(row.end_sec ?? 0) - Number(row.start_sec ?? 0));
        return duration >= 20;
      });

      console.log('[clips/export] candidate-pool', {
        project_id,
        fetched_count: (topCandidates ?? []).length,
        strong_count: strongCandidates.length,
        using_score_fallback: strongCandidates.length === 0 && (topCandidates ?? []).length > 0,
        duration_filtered_count: durationFiltered.length,
        blocked_count: blockedCount,
      });

      const deduped = durationFiltered.filter((row, index, arr) => {
        const title = String(row.title ?? '').trim().toLowerCase();
        const start = Number(row.start_sec ?? 0);
        const end = Number(row.end_sec ?? 0);
        return arr.findIndex((other) => {
          const otherTitle = String(other.title ?? '').trim().toLowerCase();
          const otherStart = Number(other.start_sec ?? 0);
          const otherEnd = Number(other.end_sec ?? 0);
          return title === otherTitle || (Math.abs(start - otherStart) < 3 && Math.abs(end - otherEnd) < 3);
        }) === index;
      });

      selectedIds = deduped
        .map((row) => String(row.id))
        .filter((id) => !blockedCandidateIds.has(id));

      if (explicitTargetCount > 0) {
        selectedIds = selectedIds.slice(0, needed);
      }
      console.log('[clips/export] after-dedupe-selection', {
        project_id,
        deduped_count: deduped.length,
        selected_count: selectedIds.length,
        selectedIds,
      });
    }

    console.log('[clips/export] counts', {
      project_id,
      requested_target_count: target_count ?? null,
      resolved_target_count: targetCount,
      selected_before_queue: selectedIds.length,
    });

    if (selectedIds.length) {
      const { data: existingCandidates, error: candidateCheckError } = await selectSelectedCandidateHooks(supabase, project_id, selectedIds);

      if (candidateCheckError) throw candidateCheckError;
      const validIds = new Set((existingCandidates ?? []).map((row) => String(row.id)));
      candidateHookText = new Map(
        (existingCandidates ?? []).map((row) => [
          String(row.id),
          normalizeHookText(readOptionalField(row, 'hook_text')) ?? normalizeHookText(row.title) ?? 'Top Moment',
        ]),
      );
      selectedIds = selectedIds.filter((id) => validIds.has(id));
    }

    if (!selectedIds.length) {
      console.log('[clips/export] no-valid-clips', {
        project_id,
        targetCount,
        blocked_count: blockedCount,
      });
      return NextResponse.json({ ok: true, queued: 0, exports: [], reason: 'no_valid_clips', counts: { selected_before_queue: 0, resolved_target_count: targetCount } });
    }

    const rows = selectedIds.map((clip_candidate_id) => ({
      project_id,
      clip_candidate_id,
      hook_text_enabled: false,
      hook_text: candidateHookText.get(clip_candidate_id) ?? null,
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
      status: 'queued',
    }));

    const { data: exportsRows, error } = await supabase.from('exports').insert(rows).select('*');
    if (error) {
      console.error('[clips/export] exports-insert-failed', { project_id, message: error.message, details: error.details, hint: error.hint, code: error.code });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const jobs = (exportsRows ?? []).map((row) => ({
      project_id,
      type: 'export',
      payload: {
        export_id: row.id,
        captions_enabled: captionsEnabled,
        caption_preset_id: captionPreset.id,
        caption_template: captionTemplate,
        caption_font: captionFont,
        hook_text_enabled: false,
        hook_text: typeof row.hook_text === 'string' ? row.hook_text : undefined,
        motion_tracking: motionTracking,
        auto_reframe: autoReframe,
        reframe_mode: reframeMode,
      },
      status: 'queued',
    }));

    if (jobs.length) {
      const { error: jErr } = await supabase.from('jobs').insert(jobs);
      if (jErr) {
        console.error('[clips/export] jobs-insert-failed', { project_id, message: jErr.message, details: jErr.details, hint: jErr.hint, code: jErr.code, export_ids: (exportsRows ?? []).map((r) => r.id) });
        await supabase.from('exports').update({ status: 'error' }).in(
          'id',
          (exportsRows ?? []).map((r) => r.id),
        );
        throw jErr;
      }
    }

    console.log('[clips/export] queued-exports', {
      project_id,
      queued_count: rows.length,
      export_ids: (exportsRows ?? []).map((row) => row.id),
    });

    return NextResponse.json({
      ok: true,
      queued: rows.length,
      counts: {
        resolved_target_count: targetCount,
        selected_before_queue: selectedIds.length,
        queued_exports: rows.length,
      },
    });
  } catch (e: unknown) {
    const serialized = serializeUnknownError(e);
    console.error('[clips/export] route-failed', serialized);
    return NextResponse.json({ error: serialized.message || 'Export queue failed', debug_type: serialized.type }, { status: 400 });
  }
}
