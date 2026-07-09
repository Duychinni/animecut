import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { downloadYouTubeAudio } from '@/lib/youtube';
import { transcribeAudioFile } from '@/lib/transcription';
import { resolveProjectVideoSource } from '@/lib/source';
import { extractAudioForTranscription } from '@/lib/ffmpeg';
import { buildMockTranscript, isMockAiEnabled } from '@/lib/dev-ai';

export async function POST(req: Request) {
  try {
    const { project_id } = await req.json();
    if (!project_id) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

    const supabase = createAdminClient();

    const { data: project, error: pErr } = await supabase
      .from('projects')
      .select('*')
      .eq('id', project_id)
      .single();

    if (pErr || !project) throw new Error('Project not found');

    if (isMockAiEnabled()) {
      const transcript = buildMockTranscript(Number(project.source_duration_seconds ?? 0));

      await supabase.from('transcripts').delete().eq('project_id', project_id);

      const { error: tErr } = await supabase.from('transcripts').insert({
        project_id,
        language: transcript.language,
        full_text: transcript.fullText,
        segments_json: transcript.segments,
      });

      if (tErr) throw tErr;

      const { error: uErr } = await supabase.from('projects').update({ status: 'transcribed' }).eq('id', project_id);
      if (uErr) throw uErr;

      return NextResponse.json({
        ok: true,
        project_id,
        mocked: true,
        language: transcript.language,
        transcript_chars: transcript.fullText.length,
        segment_count: transcript.segments.length,
      });
    }

    let mediaPath: string | null = null;
    let transcriptionPath: string | null = null;

    if (project.source_type === 'youtube') {
      if (!project.source_url) throw new Error('Missing source_url for youtube project');
      mediaPath = await downloadYouTubeAudio(project.source_url as string, project_id as string);
      transcriptionPath = mediaPath;
    } else if (project.source_type === 'upload') {
      mediaPath = await resolveProjectVideoSource({
        id: String(project.id),
        source_type: 'upload',
        source_storage_path: String(project.source_storage_path || ''),
      });
      transcriptionPath = `${mediaPath}.transcribe.mp3`;
      await extractAudioForTranscription(mediaPath, transcriptionPath);
    }

    if (!transcriptionPath) throw new Error('Unable to resolve media source');

    const transcript = await transcribeAudioFile(transcriptionPath);

    await supabase.from('transcripts').delete().eq('project_id', project_id);

    const { error: tErr } = await supabase.from('transcripts').insert({
      project_id,
      language: transcript.language,
      full_text: transcript.fullText,
      segments_json: transcript.segments,
    });

    if (tErr) throw tErr;

    const { error: uErr } = await supabase.from('projects').update({ status: 'transcribed' }).eq('id', project_id);
    if (uErr) throw uErr;

    return NextResponse.json({
      ok: true,
      project_id,
      language: transcript.language,
      transcript_chars: transcript.fullText.length,
      segment_count: transcript.segments.length,
    });
  } catch (e: unknown) {
    const message =
      e instanceof Error
        ? e.message
        : typeof e === 'string'
          ? e
          : JSON.stringify(e);

    return NextResponse.json({ error: message || 'Transcription failed' }, { status: 400 });
  }
}
