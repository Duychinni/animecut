'use client';

import { useState } from 'react';

type Props = {
  compact?: boolean;
};

export function ProjectQuickStart({ compact = false }: Props) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [loading, setLoading] = useState(false);

  async function createProject(input: { title: string; source_type: 'youtube' | 'upload'; source_url?: string }) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Failed to create project');
    return data.project.id as string;
  }

  async function onAnalyzeLink(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceUrl.trim()) return;

    try {
      setLoading(true);
      const projectId = await createProject({
        title: 'MAIN PROJECTS',
        source_type: 'youtube',
        source_url: sourceUrl.trim(),
      });

      await fetch(`/api/projects/${projectId}/start`, { method: 'POST' }).catch(() => null);
      window.location.href = `/dashboard`;
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  if (compact) {
    return (
      <form onSubmit={onAnalyzeLink} className="hidden md:flex w-[360px] items-center rounded-full border border-white/15 bg-white/[0.04] px-2 py-1.5">
        <input
          type="url"
          name="sourceUrl"
          placeholder="Drop a video link"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          className="h-8 min-w-0 flex-1 bg-transparent px-3 text-sm text-white placeholder:text-white/35 outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? '...' : 'Get Clips'}
        </button>
      </form>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-white/15 bg-white/5 p-4 md:p-5">
      <div className="flex w-full items-center gap-2 rounded-2xl border border-white/15 bg-black/35 p-2">
        <form onSubmit={onAnalyzeLink} className="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="url"
            name="sourceUrl"
            placeholder="https://youtube.com/watch?v=..."
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-transparent px-4 text-sm text-white placeholder:text-white/40 outline-none ring-0 focus:border-white/35"
          />
          <button
            type="submit"
            disabled={loading || !sourceUrl.trim()}
            className="h-11 shrink-0 rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Working...' : 'Get Clips'}
          </button>
        </form>
      </div>
    </div>
  );
}
