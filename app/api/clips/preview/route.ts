import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  const { project_id } = await req.json();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('clip_candidates')
    .select('*')
    .eq('project_id', project_id)
    .order('overall_score', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ candidates: data });
}
