import { NextResponse } from 'next/server';
import { loadClipEditData } from '@/lib/clip-edit-data';
import { createClient } from '@/lib/supabase/server';

export async function GET(_req: Request, context: { params: Promise<{ clipId: string }> }) {
  try {
    const { clipId } = await context.params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const data = await loadClipEditData(clipId, user.id);
    if (!data) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });

    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load clip';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
