import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { makeRawObjectPath } from '@/lib/storage';

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

    const ext = (filename.split('.').pop() || 'mp4').toLowerCase();
    const objectPath = makeRawObjectPath(user.id, projectId, ext);

    const { data: signed, error: signedError } = await supabase.storage
      .from('raw-media')
      .createSignedUploadUrl(objectPath);

    if (signedError) throw signedError;

    const { error: updateError } = await supabase
      .from('projects')
      .update({
        source_type: 'upload',
        source_storage_path: objectPath,
        status: 'created',
      })
      .eq('id', projectId)
      .eq('user_id', user.id);

    if (updateError) throw updateError;

    return NextResponse.json({
      ok: true,
      project_id: projectId,
      objectPath,
      signedUrl: signed.signedUrl,
      token: signed.token,
      contentType,
      size: typeof body.size === 'number' ? body.size : null,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Could not prepare upload';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
