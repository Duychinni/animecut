import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { prepareUploadTarget } from '@/lib/upload-targets';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      project_id?: string;
      filename?: string;
      contentType?: string;
      size?: number;
    };

    const projectId = String(body.project_id || '');
    const filename = String(body.filename || '');
    const contentType = String(body.contentType || 'application/octet-stream');

    if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 });
    if (!filename) return NextResponse.json({ error: 'filename required' }, { status: 400 });

    const supabase = await createClient();
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const target = await prepareUploadTarget({
      userId: user.id,
      projectId,
      filename,
      contentType,
      size: typeof body.size === 'number' ? body.size : undefined,
    });

    console.log('[ingest/upload] prepared target', {
      projectId,
      userId: user.id,
      provider: target.provider,
      objectPath: target.objectPath,
      bucket: target.bucket,
      hasUploadUrl: 'uploadUrl' in target,
      hasUploadId: 'uploadId' in target,
    });

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        source_type: 'upload',
        source_storage_path: target.objectPath,
        status: 'created',
      })
      .eq('id', projectId)
      .eq('user_id', user.id);

    if (updateError) throw updateError;

    return NextResponse.json({
      ok: true,
      project_id: projectId,
      provider: target.provider,
      bucket: target.bucket,
      objectPath: target.objectPath,
      uploadUrl: target.uploadUrl,
      method: target.method,
      headers: target.headers,
      contentType,
      size: typeof body.size === 'number' ? body.size : null,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Could not prepare upload';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
