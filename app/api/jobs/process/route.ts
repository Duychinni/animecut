import { NextResponse } from 'next/server';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveProjectVideoSource } from '@/lib/source';
import { renderVerticalClip } from '@/lib/ffmpeg';
import { segmentsToCapcutAss, segmentsToSrt } from '@/lib/srt';
import { makeExportObjectPath, uploadExportObject } from '@/lib/storage';

type JobRow = { id: string; payload: { export_id?: string } };

type ExportBundle = {
  id: string;
  project_id: string;
  clip_candidate_id: string;
  project: {
    id: string;
    user_id: string;
    source_type: 'youtube' | 'upload';
    source_url?: string | null;
    source_storage_path?: string | null;
  };
  clip: {
    start_sec: number;
    end_sec: number;
  };
  transcript: {
    segments_json: Array<{ start?: number; end?: number; text?: string }> | null;
  } | null;
};

type ExportRenderOptions = {
  captions_enabled?: boolean;
  caption_template?: 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut';
  caption_font?: 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';
  motion_tracking?: boolean;
  auto_reframe?: boolean;
  reframe_mode?: 'off' | 'basic' | 'smart';
};

async function processExportJob(exportId: string, options?: ExportRenderOptions) {
  const supabase = createAdminClient();

  const { data: ex, error } = await supabase
    .from('exports')
    .select('id, project_id, clip_candidate_id')
    .eq('id', exportId)
    .single();
  if (error || !ex) throw new Error('Export row not found');

  const [{ data: project }, { data: clip }, { data: transcript }] = await Promise.all([
    supabase
      .from('projects')
      .select('id, user_id, source_type, source_url, source_storage_path')
      .eq('id', ex.project_id)
      .single(),
    supabase
      .from('clip_candidates')
      .select('start_sec, end_sec')
      .eq('id', ex.clip_candidate_id)
      .single(),
    supabase
      .from('transcripts')
      .select('segments_json')
      .eq('project_id', ex.project_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
  ]);

  if (!project || !clip) throw new Error('Missing project/clip data');

  const bundle: ExportBundle = {
    id: String(ex.id),
    project_id: String(ex.project_id),
    clip_candidate_id: String(ex.clip_candidate_id),
    project: {
      id: String(project.id),
      user_id: String(project.user_id),
      source_type: project.source_type as 'youtube' | 'upload',
      source_url: (project.source_url as string | null) ?? null,
      source_storage_path: (project.source_storage_path as string | null) ?? null,
    },
    clip: {
      start_sec: Number(clip.start_sec),
      end_sec: Number(clip.end_sec),
    },
    transcript: transcript
      ? {
          segments_json: (transcript.segments_json as Array<{ start?: number; end?: number; text?: string }> | null) ?? null,
        }
      : null,
  };

  const inputPath = await resolveProjectVideoSource(bundle.project);

  const exportDir = path.join(process.cwd(), 'tmp', 'exports', bundle.project_id);
  await mkdir(exportDir, { recursive: true });
  const outPath = path.join(exportDir, `${bundle.id}.mp4`);

  const captionTemplate = options?.caption_template ?? 'capcut';
  const useAssCaptions = captionTemplate === 'capcut';
  const srtPath = path.join(exportDir, `${bundle.id}.${useAssCaptions ? 'ass' : 'srt'}`);

  const captionText = useAssCaptions
    ? segmentsToCapcutAss(bundle.transcript?.segments_json ?? [], bundle.clip.start_sec, bundle.clip.end_sec)
    : segmentsToSrt(bundle.transcript?.segments_json ?? [], bundle.clip.start_sec, bundle.clip.end_sec, {
        captionTemplate,
      });

  const fallbackCaption = useAssCaptions
    ? '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Montserrat,22,&H00FFFFFF,&H0000FFFF,&H00141414,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,40,40,72,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:00.50,Default,,0,0,0,,\n'
    : '1\n00:00:00,000 --> 00:00:00,500\n\n';
  await writeFile(srtPath, captionText || fallbackCaption);

  await renderVerticalClip({
    inputPath,
    outputPath: outPath,
    startSec: bundle.clip.start_sec,
    endSec: bundle.clip.end_sec,
    srtPath,
    captionsEnabled: options?.captions_enabled !== false,
    captionTemplate,
    captionFont: options?.caption_font ?? 'arial',
    motionTracking: options?.motion_tracking !== false,
    autoReframe: options?.auto_reframe !== false,
    reframeMode: options?.reframe_mode ?? 'basic',
  });

  const bytes = await readFile(outPath);
  const objectPath = makeExportObjectPath(bundle.project.user_id, bundle.project_id, bundle.id);
  await uploadExportObject(objectPath, bytes);

  const { error: e1 } = await supabase
    .from('exports')
    .update({ status: 'done', output_storage_path: objectPath, error_message: null, updated_at: new Date().toISOString() })
    .eq('id', bundle.id);
  if (e1) throw e1;
}

export async function POST() {
  const supabase = createAdminClient();

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, payload')
    .eq('status', 'queued')
    .eq('type', 'export')
    .order('created_at', { ascending: true })
    .limit(3);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  let workItems: Array<{ jobId: string | null; exportId: string | null; payload: Record<string, unknown> }> =
    ((jobs ?? []) as JobRow[]).map((job) => ({
      jobId: job.id,
      exportId: job.payload?.export_id ?? null,
      payload: (job.payload as Record<string, unknown>) ?? {},
    }));

  // Fallback path: if jobs table is empty but there are queued exports, process directly.
  if (!workItems.length) {
    const { data: queuedExports, error: exErr } = await supabase
      .from('exports')
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(3);

    if (exErr) return NextResponse.json({ error: exErr.message }, { status: 400 });

    workItems = (queuedExports ?? []).map((row) => ({
      jobId: null,
      exportId: String(row.id),
      payload: { export_id: String(row.id) },
    }));
  }

  if (!workItems.length) return NextResponse.json({ ok: true, processed: 0 });

  let processed = 0;
  for (const item of workItems) {
    try {
      if (item.jobId) {
        await supabase
          .from('jobs')
          .update({ status: 'processing', attempts: 1, updated_at: new Date().toISOString() })
          .eq('id', item.jobId);
      }

      const exportId = item.exportId;
      if (!exportId) throw new Error('Missing export_id in payload');

      await supabase
        .from('exports')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', exportId);

      await processExportJob(exportId, {
        captions_enabled: item.payload?.captions_enabled as boolean | undefined,
        caption_template: item.payload?.caption_template as
          | 'clean'
          | 'bold'
          | 'viral'
          | 'karaoke'
          | 'cinematic'
          | 'rage'
          | 'minimal'
          | 'capcut'
          | undefined,
        caption_font: item.payload?.caption_font as
          | 'arial'
          | 'montserrat'
          | 'impact'
          | 'bangers'
          | 'anton'
          | 'bebas'
          | 'poppins'
          | undefined,
        motion_tracking: item.payload?.motion_tracking as boolean | undefined,
        auto_reframe: item.payload?.auto_reframe as boolean | undefined,
        reframe_mode: item.payload?.reframe_mode as 'off' | 'basic' | 'smart' | undefined,
      });

      if (item.jobId) {
        await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', item.jobId);
      }
      processed += 1;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Job failed';
      const exportId = item.exportId;

      if (item.jobId) {
        await supabase
          .from('jobs')
          .update({ status: 'error', updated_at: new Date().toISOString(), payload: { ...item.payload, error: message } })
          .eq('id', item.jobId);
      }

      if (exportId) {
        await supabase
          .from('exports')
          .update({ status: 'error', error_message: message, updated_at: new Date().toISOString() })
          .eq('id', exportId);
      }
    }
  }

  return NextResponse.json({ ok: true, processed });
}
