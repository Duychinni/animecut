const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

function getBaseUrl() {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || DEFAULT_BASE_URL;
}

async function postJson(path: string) {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
  });

  const data = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    data,
  };
}

export async function processJobs() {
  const pipeline = await postJson('/api/pipeline/process');
  const exports = await postJson('/api/jobs/process');

  return {
    ok: pipeline.ok && exports.ok,
    pipeline,
    exports,
  };
}
