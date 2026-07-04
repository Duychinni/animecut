'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

function fmtDuration(totalSec: number | null | undefined) {
  if (typeof totalSec !== 'number' || !Number.isFinite(totalSec)) return '—';
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

type ProjectListItem = {
  id: string;
  title: string;
  status: string;
  source_type: 'youtube' | 'upload';
  source_url?: string | null;
  created_at: string;
  thumbnail_url?: string | null;
  progress_percent?: number;
  eta_seconds?: number | null;
};

export default function ProjectsPage() {
  const [title, setTitle] = useState('');
  const [sourceType, setSourceType] = useState<'upload' | 'youtube'>('youtube');
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [recentProjects, setRecentProjects] = useState<ProjectListItem[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const hasProcessingRef = useRef(true);

  async function loadProjects() {
    setLoadingProjects(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Could not load projects: ${data.error || 'unknown'}`);
        return;
      }

      const projects = ((data.projects ?? []) as ProjectListItem[]).slice(0, 8);
      const enriched = await Promise.all(
        projects.map(async (p) => {
          try {
            const pr = await fetch(`/api/projects/${p.id}/progress`, { cache: 'no-store' });
            const prData = await pr.json();
            if (!pr.ok) return p;
            return {
              ...p,
              thumbnail_url: prData?.project?.thumbnail_url ?? null,
              progress_percent: Number(prData?.progress?.percent ?? 0),
              eta_seconds: typeof prData?.progress?.eta_seconds === 'number' ? prData.progress.eta_seconds : null,
            } as ProjectListItem;
          } catch {
            return p;
          }
        }),
      );

      hasProcessingRef.current = enriched.some((p) => {
        const pct = Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0));
        return pct < 100;
      });

      setRecentProjects(enriched);
    } finally {
      setLoadingProjects(false);
    }
  }

  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      if (!hasProcessingRef.current) return;
      await loadProjects();
    };

    void loadProjects();

    const timer = setInterval(() => {
      void tick();
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  async function onDeleteProject(projectId: string) {
    const confirmed = window.confirm('Delete this project? This will remove its transcript, clips, and exports.');
    if (!confirmed) return;

    setDeletingId(projectId);
    setMsg('Deleting project...');

    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Delete failed: ${data.error || 'unknown'}`);
        return;
      }

      setRecentProjects((prev) => prev.filter((p) => p.id !== projectId));
      setMsg('Project deleted.');
    } finally {
      setDeletingId(null);
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMsg('Creating project...');

    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, source_type: sourceType, source_url: sourceType === 'youtube' ? sourceUrl || undefined : undefined }),
    });

    const data = await res.json();
    if (!res.ok) {
      setMsg(`Error: ${data.error}`);
      setLoading(false);
      return;
    }

    const projectId = data.project.id as string;

    if (sourceType === 'upload') {
      if (!file) {
        setMsg('Please select a file for upload projects.');
        setLoading(false);
        return;
      }
      setMsg('Uploading source file...');
      const form = new FormData();
      form.append('project_id', projectId);
      form.append('file', file);

      const up = await fetch('/api/ingest/upload', { method: 'POST', body: form });
      const upData = await up.json();
      if (!up.ok) {
        setMsg(`Upload failed: ${upData.error || 'unknown'}`);
        setLoading(false);
        return;
      }
    }

    window.location.href = `/dashboard/projects/${projectId}?autorun=1`;
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Projects</h1>
          <p className="mt-1 text-sm text-white/65">Create a project from a link or upload a source file.</p>
        </div>
        <Link href="/dashboard" className="rounded-lg border border-white/20 px-3 py-2 text-sm transition hover:border-white/45">
          Back to Dashboard
        </Link>
      </div>

      <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h2 className="text-lg font-semibold">Quick Start</h2>
        <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="font-medium">Step 1</p>
            <p className="mt-1 text-white/65">Create project with link or upload.</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="font-medium">Step 2</p>
            <p className="mt-1 text-white/65">Run AI pipeline for transcript + ranking.</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="font-medium">Step 3</p>
            <p className="mt-1 text-white/65">Export top clips ready for Shorts/Reels/TikTok.</p>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="text-lg font-semibold">New Project</h2>
          <p className="mt-1 text-sm text-white/60">Start with YouTube/podcast URL or local media upload.</p>

          <form className="mt-5 space-y-4" onSubmit={onCreate}>
            <div>
              <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-white/50">Project title</label>
              <input
                className="h-11 w-full rounded-lg border border-white/15 bg-black/25 px-3 text-sm text-white placeholder:text-white/35 focus:border-white/35 focus:outline-none"
                placeholder="e.g. McGregor Debate Clip Batch"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-white/50">Source type</label>
              <select
                className="h-11 w-full rounded-lg border border-white/15 bg-black/25 px-3 text-sm text-white focus:border-white/35 focus:outline-none"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as 'upload' | 'youtube')}
              >
                <option className="bg-[#111]" value="youtube">
                  YouTube / Link
                </option>
                <option className="bg-[#111]" value="upload">
                  Upload file
                </option>
              </select>
            </div>

            {sourceType === 'youtube' ? (
              <div>
                <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-white/50">Video link</label>
                <input
                  className="h-11 w-full rounded-lg border border-white/15 bg-black/25 px-3 text-sm text-white placeholder:text-white/35 focus:border-white/35 focus:outline-none"
                  placeholder="https://youtube.com/watch?v=..."
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  required
                />
              </div>
            ) : (
              <div>
                <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-white/50">Media file</label>
                <input
                  className="h-11 w-full rounded-lg border border-dashed border-white/25 bg-black/25 px-3 text-sm text-white file:mr-3 file:rounded-md file:border-0 file:bg-white/15 file:px-3 file:py-1.5 file:text-white"
                  type="file"
                  accept="video/*,audio/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  required
                />
              </div>
            )}

            <button
              className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={loading}
            >
              {loading ? 'Working...' : 'Create Project'}
            </button>
          </form>

          {msg ? <p className="mt-4 text-sm text-white/75">{msg}</p> : null}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="text-lg font-semibold">Recent Projects</h2>
          <p className="mt-1 text-sm text-white/60">Jump back into your last projects.</p>

          <div className="mt-4 space-y-2">
            {loadingProjects && <p className="text-sm text-white/60">Loading projects...</p>}
            {!loadingProjects && !recentProjects.length && <p className="text-sm text-white/60">No projects yet.</p>}

            {recentProjects.map((p) => {
              const percent = Math.max(0, Math.min(100, Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0))));
              const showProcessing = percent < 100;

              const itemBody = (
                <>
                  <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black">
                    {p.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.thumbnail_url} alt={p.title} className="h-32 w-full object-cover opacity-80" />
                    ) : (
                      <div className="grid h-32 place-items-center bg-white/5 text-xs text-white/55">No thumbnail</div>
                    )}

                    {showProcessing ? (
                      <div className="absolute inset-0 grid place-items-center bg-black/40">
                        <div className="rounded-md border border-white/25 bg-black/60 px-3 py-2 text-center">
                          <p className="text-sm font-bold text-white">{percent}%</p>
                          <p className="text-[10px] text-white/75">ETA {fmtDuration(p.eta_seconds ?? null)}</p>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <p className="mt-2 truncate font-medium">{p.title}</p>
                  <p className="mt-1 text-xs text-white/55">
                    {p.source_type.toUpperCase()} · {new Date(p.created_at).toLocaleString()}
                  </p>
                  {showProcessing ? <p className="mt-1 text-[11px] text-white/70">Processing... clickable at 100%.</p> : null}
                </>
              );

              return (
                <div key={p.id} className="rounded-lg border border-white/10 bg-black/20 p-3 transition hover:border-white/30 hover:bg-black/35">
                  <div className="flex items-start justify-between gap-3">
                    {showProcessing ? (
                      <div className="min-w-0 flex-1 opacity-95">{itemBody}</div>
                    ) : (
                      <Link href={`/dashboard/projects/${p.id}`} className="min-w-0 flex-1">
                        {itemBody}
                      </Link>
                    )}

                    <button
                      type="button"
                      onClick={() => onDeleteProject(p.id)}
                      disabled={deletingId === p.id}
                      className="shrink-0 rounded-md border border-red-400/40 px-2.5 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {deletingId === p.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
