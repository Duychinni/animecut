import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { deleteProjectAndArtifacts } from '@/lib/data-deletion';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

const renameProjectSchema = z.object({
  title: z.string().min(1).max(200),
});

export async function PATCH(req: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = renameProjectSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid title' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('projects')
      .update({ title: parsed.data.title.trim() })
      .eq('id', projectId)
      .eq('user_id', user.id)
      .select('id, title')
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, project: data });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const supabase = await createClient();

    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: project, error: pErr } = await supabase
      .from('projects')
      .select('id, user_id, source_storage_path')
      .eq('id', projectId)
      .eq('user_id', user.id)
      .single();

    if (pErr || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    await deleteProjectAndArtifacts(project);

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
