import process from 'node:process';
import { execFileSync } from 'node:child_process';

function getWorkerVersion() {
  if (process.env.GIT_COMMIT_SHA) return process.env.GIT_COMMIT_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getBaseUrl() {
  // APP_URL and NEXT_PUBLIC_APP_URL describe the customer-facing deployment.
  // Media workers must call the persistent local Next server where Python and
  // FFmpeg are installed. Calling Vercel only delegates the work back to an
  // external worker and leaves projects permanently queued.
  return process.env.WORKER_API_URL || 'http://127.0.0.1:3000';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(path: string) {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `${path} failed`);
  }
  return data as Record<string, unknown>;
}

async function runOnce() {
  const pipeline = await postJson('/api/pipeline/process').catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error), processed: 0 }));
  const jobs = await postJson('/api/jobs/process').catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error), processed: 0 }));

  const pipelineProcessed = Number(pipeline?.processed ?? 0);
  const jobsProcessed = Number(jobs?.processed ?? 0);
  const totalProcessed = pipelineProcessed + jobsProcessed;
  const pipelineDetails = pipeline as Record<string, unknown>;

  console.log('[worker] tick', {
    pipelineProcessed,
    jobsProcessed,
    totalProcessed,
    projectId: pipelineDetails.project_id ?? null,
    exportCounts: pipelineDetails.export_counts ?? null,
    analysisDiagnostics: pipelineDetails.analysis_diagnostics ?? null,
  });

  return totalProcessed;
}

async function main() {
  const once = process.argv.includes('--once');
  const baseUrl = getBaseUrl();
  console.log('[worker] starting', { baseUrl, once, commit: getWorkerVersion() });
  if (/\.vercel\.app\b/i.test(baseUrl)) {
    throw new Error('WORKER_API_URL must point to the persistent local render API (normally http://127.0.0.1:3000), not Vercel.');
  }

  if (once) {
    await runOnce();
    return;
  }

  while (true) {
    try {
      const processed = await runOnce();
      await sleep(processed > 0 ? 1200 : 4000);
    } catch (error) {
      console.error('[worker] loop error', error);
      await sleep(5000);
    }
  }
}

main().catch((error) => {
  console.error('[worker] fatal', error);
  process.exit(1);
});
