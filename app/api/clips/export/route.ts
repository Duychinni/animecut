import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTargetClipCount } from '@/lib/clip-policy';

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

export async function POST(req: Request) {
  try {
    const {
      project_id,
      candidate_ids,
      target_count,
      captions_enabled,
      caption_template,
      caption_font,
      motion_tracking,
      auto_reframe,
      reframe_mode,
    } = await req.json();
    const supabase = createAdminClient();

    const captionsEnabled = captions_enabled !== false;
    const captionTemplate = (caption_template ?? 'capcut') as
      | 'clean'
      | 'bold'
      | 'viral'
      | 'karaoke'
      | 'cinematic'
      | 'rage'
      | 'minimal'
      | 'capcut';
    const captionFont = (caption_font ?? 'montserrat') as 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';
    // Speed-first default: motion tracking is expensive (extra ffmpeg analysis pass).
    // Enable explicitly per request when needed.
    const motionTracking = motion_tracking === true;
    const autoReframe = auto_reframe !== false;
    const reframeMode = (reframe_mode ?? 'smart') as 'off' | 'basic' | 'smart';

    let targetCount = Math.max(1, Math.min(20, Number(target_count ?? 0)));
    let selectedIds = Array.isArray(candidate_ids) ? (candidate_ids as string[]) : [];
    let blockedCount = 0;

    if (!selectedIds.length) {
      const [{ data: existingExports, error: exErr }, { data: topCandidates, error: cErr }] = await Promise.all([
        supabase
          .from('exports')
          .select('clip_candidate_id, status')
          .eq('project_id', project_id),
        supabase
          .from('clip_candidates')
          .select('id, overall_score, duration_seconds, title, start_sec, end_sec')
          .eq('project_id', project_id)
          .gte('overall_score', 7.0)
          .order('overall_score', { ascending: false })
          .limit(100),
      ]);

      if (exErr) throw exErr;
      if (cErr) throw cErr;

      if (!(target_count > 0)) {
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
        targetCount = Math.max(5, Math.min(desired, (topCandidates ?? []).length || desired));
      }

      const doneCount = (existingExports ?? []).filter((r) => r.status === 'done').length;
      const inFlightCount = (existingExports ?? []).filter((r) => r.status === 'queued' || r.status === 'processing').length;
      const needed = Math.max(0, targetCount - doneCount - inFlightCount);

      const blockedCandidateIds = new Set(
        (existingExports ?? [])
          .map((r) => (r.clip_candidate_id ? String(r.clip_candidate_id) : null))
          .filter((v): v is string => Boolean(v)),
      );
      blockedCount = blockedCandidateIds.size;

      const durationFiltered = (topCandidates ?? []).filter((row) => {
        const explicitDuration = Number(row.duration_seconds ?? NaN);
        const derivedDuration = Math.max(0, Number(row.end_sec ?? 0) - Number(row.start_sec ?? 0));
        const duration = Number.isFinite(explicitDuration) && explicitDuration > 0 ? explicitDuration : derivedDuration;
        return duration >= 20;
      });

      console.log('[clips/export] candidate-pool', {
        project_id,
        fetched_count: (topCandidates ?? []).length,
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
        .filter((id) => !blockedCandidateIds.has(id))
        .slice(0, Math.min(needed, 10));
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
        caption_template: captionTemplate,
        caption_font: captionFont,
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
