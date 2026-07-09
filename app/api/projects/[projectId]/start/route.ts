import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ensurePipelineJob } from '@/lib/pipeline';
import { rawMediaObjectExists } from '@/lib/storage';
import { ensureProjectUploadThumbnail } from '@/lib/upload-thumbnail';

export async function POST(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: project, error } = await supabase
      .from('projects')
      .select('id, user_id, source_type, source_url, source_storage_path, pipeline_status')
      .eq('id', projectId)
      .eq('user_id', user.id)
      .single();

    if (error || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    if (project.source_type === 'youtube' && !project.source_url) {
      return NextResponse.json({ error: 'Project source is not ready yet' }, { status: 400 });
    }

    if (project.source_type === 'upload' && !project.source_storage_path) {
      return NextResponse.json({ error: 'Upload source is not ready yet' }, { status: 400 });
    }

    if (project.source_type === 'upload' && project.source_storage_path) {
      const exists = await rawMediaObjectExists(project.source_storage_path);
      if (!exists) {
        return NextResponse.json({ error: 'Upload is still finalizing. Please wait a moment and try again.' }, { status: 409 });
      }
    }

    const job = await ensurePipelineJob(projectId);
    console.log('[projects/start] queued-pipeline-job', { projectId, jobId: job.id, status: job.status, sourceType: project.source_type });

    if (project.source_type === 'upload') {
      void ensureProjectUploadThumbnail({
        id: project.id,
        user_id: user.id,
        source_type: 'upload',
        source_storage_path: project.source_storage_path,
      }).catch((thumbnailError) => {
        console.warn('[projects/start] upload-thumbnail failed', {
          projectId,
          error: thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError),
        });
      });
    }

    return NextResponse.json({ ok: true, job });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not start pipeline';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
