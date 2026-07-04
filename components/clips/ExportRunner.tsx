'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Candidate = { id: string; title: string; overall_score: number };

export function ExportRunner({ projectId, candidates }: { projectId: string; candidates: Candidate[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  async function runExport() {
    if (!candidates.length) {
      setMsg('No candidates to export.');
      return;
    }

    setLoading(true);
    setMsg('Queueing exports...');

    const ids = candidates.slice(0, 3).map((c) => c.id);
    const q = await fetch('/api/clips/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, candidate_ids: ids }),
    });
    const qData = await q.json();
    if (!q.ok) {
      setMsg(`Queue failed: ${qData.error || 'unknown'}`);
      setLoading(false);
      return;
    }

    setMsg('Processing exports...');
    const p = await fetch('/api/jobs/process', { method: 'POST' });
    const pData = await p.json();

    if (!p.ok) {
      setMsg(`Process failed: ${pData.error || 'unknown'}`);
      setLoading(false);
      return;
    }

    setMsg(`Export done. Processed ${pData.processed ?? 0} job(s).`);
    router.refresh();
    setLoading(false);
  }

  return (
    <div className="space-y-2">
      <button
        disabled={loading}
        onClick={runExport}
        className="rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Exporting...' : 'Export Top 3 Clips'}
      </button>
      <p className="text-sm text-white/70">{msg}</p>
    </div>
  );
}
