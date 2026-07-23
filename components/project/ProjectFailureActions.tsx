'use client';

import { useState } from 'react';
import { captureEvent } from '@/lib/analytics';

export function ProjectFailureActions({ projectId, detail }: { projectId: string; detail?: string | null }) {
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState('');

  async function retry() {
    setRetrying(true);
    setMessage('');
    const response = await fetch(`/api/projects/${projectId}/start`, { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(String(payload?.error || 'Could not retry this project.'));
      setRetrying(false);
      return;
    }
    window.location.reload();
  }

  return (
    <section className="mx-auto w-full max-w-2xl rounded-3xl border border-red-300/20 bg-red-400/[0.06] p-7 text-center">
      <h2 className="text-2xl font-bold">Processing didn’t finish</h2>
      <p className="mt-2 text-sm leading-6 text-white/65">Your upload is still saved. Retry the job, or contact support and include this project ID: <span className="font-mono text-white/85">{projectId}</span>.</p>
      {detail ? <p className="mt-3 text-xs text-red-200/70">{detail}</p> : null}
      {message ? <p className="mt-3 text-sm text-red-200">{message}</p> : null}
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <button disabled={retrying} onClick={() => { captureEvent('render_failed', { recovery: 'retry_clicked' }); void retry(); }} className="rounded-xl bg-white px-4 py-2.5 font-bold text-black disabled:opacity-50">{retrying ? 'Retrying…' : 'Retry processing'}</button>
        <a href={`/contact?project=${encodeURIComponent(projectId)}`} className="rounded-xl border border-white/15 px-4 py-2.5 font-bold">Contact support</a>
      </div>
    </section>
  );
}
