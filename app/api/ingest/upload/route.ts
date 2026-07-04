import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { makeRawObjectPath, uploadRawMediaObject } from '@/lib/storage';

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const projectId = String(form.get('project_id') || '');
    const file = form.get('file');

    if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });

    const supabase = await createClient();
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const bytes = Buffer.from(await file.arrayBuffer());
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const objectPath = makeRawObjectPath(user.id, projectId, ext);
    await uploadRawMediaObject(objectPath, bytes, file.type || 'application/octet-stream');

    const { error } = await supabase
      .from('projects')
      .update({ source_type: 'upload', source_storage_path: objectPath, status: 'created' })
      .eq('id', projectId)
      .eq('user_id', user.id);

    if (error) throw error;

    return NextResponse.json({ ok: true, project_id: projectId, source_storage_path: objectPath });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Upload failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
