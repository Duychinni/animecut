import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { makeRawObjectPath, uploadRawMediaObject } from '@/lib/storage';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB soft limit for current direct upload flow

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const projectId = String(form.get('project_id') || '');
    const file = form.get('file');

    if (!projectId) return NextResponse.json({ error: 'project_id required' }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: 'file required' }, { status: 400 });

    if (file.size > MAX_UPLOAD_BYTES) {
      const sizeMb = Math.round(file.size / (1024 * 1024));
      return NextResponse.json(
        {
          error: `This file is too large for the current upload flow (${sizeMb}MB). Please keep uploads under 500MB for now, or use a shorter/compressed source file.`,
        },
        { status: 400 },
      );
    }

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
    const rawMessage = e instanceof Error ? e.message : 'Upload failed';
    const message = /maximum allowed size|object exceeded the maximum allowed size/i.test(rawMessage)
      ? 'This file is too large for the current upload flow. Please keep uploads under 500MB for now, or compress the source video before uploading.'
      : rawMessage;
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
