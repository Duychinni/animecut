import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createExportDownloadUrl } from '@/lib/storage';

function safeFileName(title: string) {
  const stem = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
  return `${stem || 'animacut-reel'}.mp4`;
}

export async function GET(_request: Request, context: { params: Promise<{ exportId: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { exportId } = await context.params;
  const admin = createAdminClient();
  const { data: exportRow, error } = await admin
    .from('exports')
    .select('output_storage_path, projects!inner(user_id), clip_candidates(title)')
    .eq('id', exportId)
    .single();

  const project = exportRow?.projects as unknown as { user_id?: string } | null;
  if (error || !exportRow || project?.user_id !== user.id || !exportRow.output_storage_path) {
    return NextResponse.json({ error: 'Reel not found' }, { status: 404 });
  }

  const candidate = exportRow.clip_candidates as unknown as { title?: string } | null;
  const url = await createExportDownloadUrl(
    exportRow.output_storage_path,
    safeFileName(candidate?.title ?? 'animacut-reel'),
  );
  return NextResponse.redirect(url, 307);
}
