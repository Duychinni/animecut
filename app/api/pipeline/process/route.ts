import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const STEP_PROGRESS: Record<string, number> = {
  queued: 0,
  downloading: 5,
  extracting_audio: 10,
  transcribing: 25,
  finding_hooks: 40,
  creating_clips: 55,
  face_tracking_crop: 70,
  rendering: 85,
  uploading_outputs: 95,
  completed: 100,
};

function getInternalBaseUrls() {
  return [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ].filter((v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i);
}

async function callInternalJson(path: string, body: Record<string, unknown>) {
  let lastError: string | null = null;

  for (const baseUrl of getInternalBaseUrls()) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = typeof data?.error === 'string' ? data.error : `Pipeline step failed: ${path}`;
        continue;
      }

      return data;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : `Request failed for ${path}`;
    }
  }

  throw new Error(lastError || `Pipeline step failed: ${path}`);
}

async function updateProjectProgress(projectId: string, step: string, label: string, extra: Record<string, unknown> = {}) {
  const supabase = createAdminClient();
  const payload = {
    pipeline_status: step === 'completed' ? 'completed' : step === 'failed' ? 'error' : 'processing',
    pipeline_stage: step,
    pipeline_stage_label: label,
    pipeline_progress_percent: step === 'failed' ? undefined : (STEP_PROGRESS[step] ?? 0),
    worker_last_seen_at: new Date().toISOString(),
    worker_last_log_message: label,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  console.log('[pipeline/progress]', { projectId, step, label, extra });
  await supabase.from('projects').update(payload).eq('id', projectId);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
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
    .update({ pipeline_status: 'processing', pipeline_error: null, worker_started_at: new Date().toISOString(), worker_last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', projectId);

  await updateProjectProgress(projectId, 'downloading', 'Preparing source video');

  try {
    await updateProjectProgress(projectId, 'extracting_audio', 'Extracting audio');
    console.log('[pipeline] before transcribe', { projectId });
    await updateProjectProgress(projectId, 'transcribing', 'Transcribing audio');
    await callInternalJson('/api/transcribe', { project_id: projectId });
    console.log('[pipeline] after transcribe', { projectId });

    await updateProjectProgress(projectId, 'finding_hooks', 'Finding hooks');
    console.log('[pipeline] before analyze', { projectId });
    await withTimeout(callInternalJson('/api/analyze', { project_id: projectId }), 120000, 'finding_hooks timeout after 2 minutes');
    console.log('[pipeline] after analyze', { projectId });

    await updateProjectProgress(projectId, 'creating_clips', 'Creating top clip candidates');

    for (let round = 0; round < 8; round += 1) {
      await updateProjectProgress(projectId, 'rendering', `Queueing/rendering clips (pass ${round + 1})`);
      let queueData: Record<string, unknown> = {};
      try {
        queueData = await callInternalJson('/api/clips/export', { project_id: projectId });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Pipeline step failed: /api/clips/export';
        const alreadyQueuedLike = /duplicate|already exists|already queued|unique/i.test(message);
        if (!alreadyQueuedLike) {
          throw error;
        }
        queueData = { queued: 0, recovered: true };
      }
      const queued = Number(queueData?.queued ?? 0);

      let idlePasses = 0;
      for (let i = 0; i < 10; i += 1) {
        let processed = 0;
        let processOk = false;
        let processError = 'Export processing failed';

        for (const baseUrl of getInternalBaseUrls()) {
          try {
            const processRes = await fetch(`${baseUrl}/api/jobs/process`, {
              method: 'POST',
              cache: 'no-store',
            });
            const processData = await processRes.json().catch(() => ({}));
            if (!processRes.ok) {
              processError = typeof processData?.error === 'string' ? processData.error : 'Export processing failed';
              continue;
            }

            processed = Number(processData?.processed ?? 0);
            processOk = true;
            break;
          } catch (error: unknown) {
            processError = error instanceof Error ? error.message : 'Export processing failed';
          }
        }

        if (!processOk) {
          throw new Error(processError);
        }
        if (processed === 0) {
          idlePasses += 1;
          if (idlePasses >= 3) break;
        } else {
          idlePasses = 0;
        }
      }

      if (queued === 0) break;
    }

    await updateProjectProgress(projectId, 'uploading_outputs', 'Uploading final clips');

    await supabase
      .from('projects')
      .update({
        pipeline_status: 'completed',
        pipeline_stage: 'completed',
        pipeline_stage_label: 'Completed',
        pipeline_progress_percent: 100,
        pipeline_error: null,
        pipeline_completed_at: new Date().toISOString(),
        worker_last_seen_at: new Date().toISOString(),
        worker_last_log_message: 'Completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId);

    await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job.id);

    return NextResponse.json({ ok: true, processed: 1, project_id: projectId });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Pipeline failed';

    const { data: currentProject } = await supabase.from('projects').select('pipeline_progress_percent').eq('id', projectId).single();
    await supabase
      .from('projects')
      .update({
        pipeline_status: 'error',
        pipeline_stage: 'failed',
        pipeline_stage_label: 'Failed',
        pipeline_progress_percent: Number(currentProject?.pipeline_progress_percent ?? 0),
        pipeline_error: message,
        worker_last_seen_at: new Date().toISOString(),
        worker_last_log_message: message,
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
