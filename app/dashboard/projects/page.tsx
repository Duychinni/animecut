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
  const [recentProjects, setRecentProjects] = useState<ProjectListItem[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
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

      const projects = ((data.projects ?? []) as ProjectListItem[]).slice(0, 24);
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

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Projects</h1>
          <p className="mt-1 text-sm text-white/60">Click a thumbnail to reopen its saved clips.</p>
        </div>
        <Link href="/dashboard" className="rounded-lg border border-white/20 px-3 py-2 text-sm transition hover:border-white/45">
          Back to Dashboard
        </Link>
      </div>

      {msg ? <p className="mb-4 text-sm text-white/75">{msg}</p> : null}

      {loadingProjects && <p className="text-sm text-white/60">Loading projects...</p>}
      {!loadingProjects && !recentProjects.length && <p className="text-sm text-white/60">No projects yet.</p>}

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {recentProjects.map((p) => {
          const percent = Math.max(0, Math.min(100, Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0))));
          const showProcessing = percent < 100;

          const cardBody = (
            <>
              <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
                {p.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.thumbnail_url} alt={p.title} className="aspect-video w-full object-cover brightness-110" />
                ) : (
                  <div className="grid aspect-video place-items-center bg-white/5 text-xs text-white/55">No thumbnail</div>
                )}

                {showProcessing ? (
                  <div className="absolute inset-0 grid place-items-center bg-black/45">
                    <div className="rounded-md border border-white/25 bg-black/60 px-3 py-2 text-center">
                      <p className="text-sm font-bold text-white">{percent}%</p>
                      <p className="text-[10px] text-white/75">ETA {fmtDuration(p.eta_seconds ?? null)}</p>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mt-3">
                <p className="line-clamp-2 font-medium text-white">{p.title}</p>
                <p className="mt-1 text-xs text-white/50">
                  {p.source_type.toUpperCase()} · {new Date(p.created_at).toLocaleDateString()}
                </p>
              </div>
            </>
          );

          return (
            <div key={p.id} className="group rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-white/25 hover:bg-white/[0.05]">
              <div className="flex items-start justify-between gap-3">
                {showProcessing ? (
                  <div className="min-w-0 flex-1 opacity-95">{cardBody}</div>
                ) : (
                  <Link href={`/dashboard/projects/${p.id}`} className="min-w-0 flex-1">
                    {cardBody}
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
    </main>
  );
}
