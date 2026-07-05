import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { fetchYouTubeSourceMetadata } from '@/lib/source-metadata';

export async function POST(req: Request) {
  try {
    const { project_id, source_url } = await req.json();
    if (!project_id || !source_url) {
      return NextResponse.json({ error: 'project_id and source_url are required' }, { status: 400 });
    }

    const supabase = await createClient();
    const sourceMeta = await fetchYouTubeSourceMetadata(source_url);
    const { error } = await supabase
      .from('projects')
      .update({
        source_type: 'youtube',
        source_url,
        source_platform: sourceMeta.sourcePlatform,
        source_video_id: sourceMeta.sourceVideoId,
        source_title: sourceMeta.sourceTitle,
        source_thumbnail_url: sourceMeta.sourceThumbnailUrl,
        source_channel_name: sourceMeta.sourceChannelName,
        source_duration_seconds: sourceMeta.sourceDurationSeconds,
        title: sourceMeta.sourceTitle || undefined,
        status: 'created',
      })
      .eq('id', project_id);

    if (error) throw error;

    return NextResponse.json({ ok: true, project_id, source_url });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
