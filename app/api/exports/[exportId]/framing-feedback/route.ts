import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const schema = z.object({
  rating: z.enum(['good', 'needs_adjustment']),
  issueType: z.enum(['wrong_speaker', 'subject_cut_off', 'bad_split', 'too_much_motion', 'missed_context', 'other']).nullable().optional(),
  playheadSeconds: z.number().min(0).nullable().optional(),
  correction: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ exportId: string }> }) {
  const { exportId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid framing feedback' }, { status: 400 });
  const admin = createAdminClient();
  const { data: clip } = await admin
    .from('exports')
    .select('id, project_id, projects!inner(user_id)')
    .eq('id', exportId)
    .eq('projects.user_id', user.id)
    .maybeSingle();
  if (!clip) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  const body = parsed.data;
  const { error } = await admin.from('framing_feedback').insert({
    user_id: user.id,
    project_id: clip.project_id,
    export_id: exportId,
    rating: body.rating,
    issue_type: body.issueType ?? null,
    playhead_seconds: body.playheadSeconds ?? null,
    correction: body.correction ?? null,
    notes: body.notes ?? null,
  });
  if (error) return NextResponse.json({ error: 'Could not save feedback' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
