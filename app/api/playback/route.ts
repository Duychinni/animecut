import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const schema = z.object({
  sessionId: z.string().uuid(),
  exportId: z.string().uuid(),
  previewQuality: z.enum(['master', '360p', '540p']),
  startupMs: z.number().int().min(0).max(600000).nullable().optional(),
  bufferingCount: z.number().int().min(0).max(10000).default(0),
  failed: z.boolean().default(false),
  errorCode: z.string().max(120).nullable().optional(),
  connectionType: z.string().max(40).nullable().optional(),
  effectiveType: z.string().max(40).nullable().optional(),
  downlinkMbps: z.number().min(0).max(100000).nullable().optional(),
  clipSizeBytes: z.number().int().min(0).nullable().optional(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid playback telemetry' }, { status: 400 });
  const admin = createAdminClient();
  const { data: ownedExport } = await admin
    .from('exports')
    .select('id, projects!inner(user_id)')
    .eq('id', parsed.data.exportId)
    .eq('projects.user_id', user.id)
    .maybeSingle();
  if (!ownedExport) return NextResponse.json({ error: 'Clip not found' }, { status: 404 });

  const network = request.headers.get('user-agent') ?? null;
  const payload = parsed.data;
  const { error } = await admin.from('playback_sessions').upsert({
    session_id: payload.sessionId,
    user_id: user.id,
    export_id: payload.exportId,
    preview_quality: payload.previewQuality,
    startup_ms: payload.startupMs ?? null,
    buffering_count: payload.bufferingCount,
    failed: payload.failed,
    error_code: payload.errorCode ?? null,
    connection_type: payload.connectionType ?? null,
    effective_type: payload.effectiveType ?? null,
    downlink_mbps: payload.downlinkMbps ?? null,
    clip_size_bytes: payload.clipSizeBytes ?? null,
    user_agent: network,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,export_id,session_id' });
  if (error) return NextResponse.json({ error: 'Could not save playback telemetry' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
