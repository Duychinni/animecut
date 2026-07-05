import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

async function callInternalJson(path: string, body: Record<string, unknown>) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://127.0.0.1:3000';
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Pipeline step failed: ${path}`;
    throw new Error(message);
  }

  return data;
}

export async function POST() {
  const supabase = createAdminClient();

  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, project_id, payload, status')
    .eq('type', 'pipeline')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!jobs?.length) return NextResponse.json({ ok: true, processed: 0 });

  const job = jobs[0];
  const projectId = String(job.project_id || job.payload?.project_id || '');
  if (!projectId) {
    return NextResponse.json({ error: 'Pipeline job missing project_id' }, { status: 400 });
  }

  await supabase
    .from('jobs')
    .update({ status: 'processing', attempts: 1, updated_at: new Date().toISOString() })
    .eq('id', job.id);

  await supabase
    .from('projects')
    .update({ pipeline_status: 'processing', pipeline_error: null, updated_at: new Date().toISOString() })
    .eq('id', projectId);

  try {
    await callInternalJson('/api/transcribe', { project_id: projectId });
    await callInternalJson('/api/analyze', { project_id: projectId });

    for (let round = 0; round < 8; round += 1) {
      const queueData = await callInternalJson('/api/clips/export', { project_id: projectId });
      const queued = Number(queueData?.queued ?? 0);

      let idlePasses = 0;
      for (let i = 0; i < 10; i += 1) {
        const processRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://127.0.0.1:3000'}/api/jobs/process`, {
          method: 'POST',
          cache: 'no-store',
        });
        const processData = await processRes.json().catch(() => ({}));
        if (!processRes.ok) {
          throw new Error(typeof processData?.error === 'string' ? processData.error : 'Export processing failed');
        }

        const processed = Number(processData?.processed ?? 0);
        if (processed === 0) {
          idlePasses += 1;
          if (idlePasses >= 3) break;
        } else {
          idlePasses = 0;
        }
      }

      if (queued === 0) break;
    }

    await supabase
      .from('projects')
      .update({
        pipeline_status: 'completed',
        pipeline_error: null,
        pipeline_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);

    await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job.id);

    return NextResponse.json({ ok: true, processed: 1, project_id: projectId });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Pipeline failed';

    await supabase
      .from('projects')
      .update({
        pipeline_status: 'error',
        pipeline_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);

    await supabase
      .from('jobs')
      .update({
        status: 'error',
        payload: { ...(job.payload ?? {}), error: message },
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
