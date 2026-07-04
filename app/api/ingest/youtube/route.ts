import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const { project_id, source_url } = await req.json();
    if (!project_id || !source_url) {
      return NextResponse.json({ error: 'project_id and source_url are required' }, { status: 400 });
    }

    const supabase = await createClient();
    const { error } = await supabase
      .from('projects')
      .update({ source_type: 'youtube', source_url, status: 'created' })
      .eq('id', project_id);

    if (error) throw error;

    return NextResponse.json({ ok: true, project_id, source_url });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
