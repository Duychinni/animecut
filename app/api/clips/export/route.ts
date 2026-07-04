import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

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
    const reframeMode = (reframe_mode ?? 'basic') as 'off' | 'basic' | 'smart';

    let targetCount = Math.max(1, Math.min(20, Number(target_count ?? 0)));
    let selectedIds = Array.isArray(candidate_ids) ? (candidate_ids as string[]) : [];

    if (!selectedIds.length) {
      const [{ data: existingExports, error: exErr }, { data: topCandidates, error: cErr }] = await Promise.all([
        supabase
          .from('exports')
          .select('clip_candidate_id, status')
          .eq('project_id', project_id),
        supabase
          .from('clip_candidates')
          .select('id, overall_score')
          .eq('project_id', project_id)
          .order('overall_score', { ascending: false })
          .limit(100),
      ]);

      if (exErr) throw exErr;
      if (cErr) throw cErr;

      if (!(target_count > 0)) {
        const goodCount = (topCandidates ?? []).filter((row) => Number(row.overall_score ?? 0) >= 8).length;
        const fallbackCount = (topCandidates ?? []).filter((row) => Number(row.overall_score ?? 0) >= 7).length;
        const inferred = goodCount >= 5 ? goodCount : fallbackCount;
        targetCount = Math.max(5, Math.min(10, inferred || Math.min(10, (topCandidates ?? []).length || 5)));
      }

      const doneCount = (existingExports ?? []).filter((r) => r.status === 'done').length;
      const inFlightCount = (existingExports ?? []).filter((r) => r.status === 'queued' || r.status === 'processing').length;
      const needed = Math.max(0, targetCount - doneCount - inFlightCount);

      const blockedCandidateIds = new Set(
        (existingExports ?? [])
          .map((r) => (r.clip_candidate_id ? String(r.clip_candidate_id) : null))
          .filter((v): v is string => Boolean(v)),
      );

      selectedIds = (topCandidates ?? [])
        .map((row) => String(row.id))
        .filter((id) => !blockedCandidateIds.has(id))
        .slice(0, needed);
    }

    if (!selectedIds.length) {
      return NextResponse.json({ ok: true, queued: 0 });
    }

    const rows = selectedIds.map((clip_candidate_id) => ({
      project_id,
      clip_candidate_id,
      status: 'queued',
    }));

    const { data: exportsRows, error } = await supabase.from('exports').insert(rows).select('*');
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

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
        await supabase.from('exports').update({ status: 'error' }).in(
          'id',
          (exportsRows ?? []).map((r) => r.id),
        );
        throw jErr;
      }
    }

    return NextResponse.json({ ok: true, queued: rows.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Export queue failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
