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
  source_title?: string | null;
  source_thumbnail_url?: string | null;
  source_channel_name?: string | null;
  source_duration_seconds?: number | null;
  thumbnail_url?: string | null;
  progress_percent?: number;
  eta_seconds?: number | null;
};

export default function DashboardPage() {
  const [recentProjects, setRecentProjects] = useState<ProjectListItem[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'recent' | 'older' | 'az' | 'za'>('recent');
  const [statusFilter, setStatusFilter] = useState<'all' | 'processing' | 'completed' | 'failed'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'youtube' | 'upload'>('all');
  const [msg, setMsg] = useState('');
  const hasProcessingRef = useRef(true);
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  async function loadProjects(initial = false) {
    if (initial) setLoadingProjects(true);
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Could not load projects: ${data.error || 'unknown'}`);
        return;
      }

      const projects = ((data.projects ?? []) as ProjectListItem[]).slice(0, 24);

      if (initial || recentProjects.length === 0) {
        const enriched = await Promise.all(
          projects.map(async (p) => {
            try {
              const pr = await fetch(`/api/projects/${p.id}/progress`, { cache: 'no-store' });
              const prData = await pr.json();
              if (!pr.ok) return p;
              return {
                ...p,
                thumbnail_url: prData?.project?.thumbnail_url ?? p.source_thumbnail_url ?? null,
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
        return;
      }

      const processingIds = recentProjects
        .filter((p) => Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0)) < 100)
        .map((p) => p.id);

      const progressUpdates = await Promise.all(
        processingIds.map(async (id) => {
          try {
            const pr = await fetch(`/api/projects/${id}/progress`, { cache: 'no-store' });
            const prData = await pr.json();
            if (!pr.ok) return null;
            return {
              id,
              thumbnail_url: prData?.project?.thumbnail_url ?? null,
              progress_percent: Number(prData?.progress?.percent ?? 0),
              eta_seconds: typeof prData?.progress?.eta_seconds === 'number' ? prData.progress.eta_seconds : null,
            };
          } catch {
            return null;
          }
        }),
      );

      setRecentProjects((prev) => {
        const merged = projects.map((project) => {
          const previous = prev.find((p) => p.id === project.id);
          const update = progressUpdates.find((u) => u?.id === project.id);
          return {
            ...previous,
            ...project,
            ...(update ?? {}),
          } as ProjectListItem;
        });

        hasProcessingRef.current = merged.some((p) => {
          const pct = Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0));
          return pct < 100;
        });

        return merged;
      });
    } finally {
      if (initial) setLoadingProjects(false);
    }
  }

  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      if (!hasProcessingRef.current) return;
      await loadProjects();
    };

    void loadProjects(true);

    const timer = setInterval(() => {
      void tick();
    }, 12000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!menuRootRef.current) return;
      if (!menuRootRef.current.contains(event.target as Node)) {
        setOpenMenuId(null);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  function beginRename(projectId: string, currentTitle: string) {
    setRenamingId(projectId);
    setRenameDraft(currentTitle);
    setOpenMenuId(null);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }

  async function saveRename(projectId: string) {
    const nextTitle = renameDraft.trim();
    const currentProject = recentProjects.find((p) => p.id === projectId);
    const currentTitle = currentProject?.title?.trim() ?? '';

    if (!nextTitle) {
      cancelRename();
      return;
    }

    if (nextTitle === currentTitle) {
      cancelRename();
      return;
    }

    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: nextTitle }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(`Rename failed: ${data.error || 'unknown'}`);
        return;
      }

      setRecentProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, title: nextTitle } : p)));
      setMsg('');
      cancelRename();
    } catch {
      setMsg('Rename failed: unknown');
    }
  }

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
      setOpenMenuId(null);
    }
  }

  const orderedProjects = [...recentProjects]
    .filter((p) => {
      const matchesSearch = searchQuery.trim() ? (p.source_title || p.title).toLowerCase().includes(searchQuery.trim().toLowerCase()) : true;

      const percent = Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0));
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'processing'
            ? percent < 100 && p.status !== 'failed'
            : statusFilter === 'completed'
              ? percent >= 100 || p.status === 'completed'
              : p.status === 'failed';

      const matchesSource = sourceFilter === 'all' ? true : p.source_type === sourceFilter;

      return matchesSearch && matchesStatus && matchesSource;
    })
    .sort((a, b) => {
      const aTime = new Date(a.created_at).getTime();
      const bTime = new Date(b.created_at).getTime();
      if (sortOrder === 'recent') return bTime - aTime;
      if (sortOrder === 'older') return aTime - bTime;
      if (sortOrder === 'az') return (a.source_title || a.title).localeCompare(b.source_title || b.title);
      return (b.source_title || b.title).localeCompare(a.source_title || a.title);
    });

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="mt-1 text-sm text-white/60">Click a thumbnail to reopen its saved clips.</p>
        </div>
      </div>

      <div className="mb-6 grid gap-3 md:grid-cols-[minmax(260px,1fr)_auto_auto_auto]">
        <input
          type="text"
          placeholder="Search videos..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="rounded-lg border border-white/15 bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder:text-white/35 outline-none transition focus:border-white/30"
        />

        <select
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value as 'recent' | 'older' | 'az' | 'za')}
          className="rounded-lg border border-white/15 bg-[#111218] px-3 py-2.5 text-sm text-white outline-none transition focus:border-white/30"
        >
          <option value="recent">Recent</option>
          <option value="older">Older</option>
          <option value="az">A–Z</option>
          <option value="za">Z–A</option>
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'processing' | 'completed' | 'failed')}
          className="rounded-lg border border-white/15 bg-[#111218] px-3 py-2.5 text-sm text-white outline-none transition focus:border-white/30"
        >
          <option value="all">All Status</option>
          <option value="processing">Processing</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>

        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as 'all' | 'youtube' | 'upload')}
          className="rounded-lg border border-white/15 bg-[#111218] px-3 py-2.5 text-sm text-white outline-none transition focus:border-white/30"
        >
          <option value="all">All Sources</option>
          <option value="youtube">YouTube</option>
          <option value="upload">Upload</option>
        </select>
      </div>

      {msg ? <p className="mb-4 text-sm text-white/75">{msg}</p> : null}

      {loadingProjects && <p className="text-sm text-white/60">Loading projects...</p>}
      {!loadingProjects && !recentProjects.length && <p className="text-sm text-white/60">No projects yet.</p>}

      <div ref={menuRootRef} className="grid gap-8 md:grid-cols-2 xl:grid-cols-3">
        {orderedProjects.map((p) => {
          const percent = Math.max(0, Math.min(100, Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0))));
          const showProcessing = percent < 100;

          const thumb = (
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
              {p.thumbnail_url || p.source_thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumbnail_url || p.source_thumbnail_url || ''} alt={p.source_title || p.title} className="aspect-video w-full object-cover brightness-110" />
              ) : (
                <div className="grid aspect-video place-items-center bg-white/5 text-xs text-white/55">No thumbnail</div>
              )}
            </div>
          );

          return (
            <div key={p.id} className="group rounded-2xl bg-transparent p-4 transition hover:bg-white/[0.02]">
              <div className="min-w-0">
                <Link href={`/dashboard/projects/${p.id}`}>{thumb}</Link>

                <div className="mt-3">
                  {renamingId === p.id ? (
                    <input
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveRename(p.id);
                        if (e.key === 'Escape') cancelRename();
                      }}
                      onBlur={() => void saveRename(p.id)}
                      autoFocus
                      className="w-full rounded-md border border-white/20 bg-white/[0.04] px-2 py-1 text-sm font-medium text-white outline-none"
                    />
                  ) : (
                    <p className="line-clamp-2 font-medium text-white">{p.source_title || p.title}</p>
                  )}
                  <div className="mt-1 flex items-end justify-between gap-3">
                    <p className="text-xs text-white/50">
                      {p.source_channel_name ? `${p.source_channel_name} · ` : ''}{p.source_type.toUpperCase()} · {new Date(p.created_at).toLocaleDateString()}
                      {showProcessing ? ` · ${percent}% processing` : ''}
                    </p>

                    <div className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => setOpenMenuId((prev) => (prev === p.id ? null : p.id))}
                        className="rounded-md border border-white/12 bg-white/[0.03] px-2 py-1 text-white/75 transition hover:border-white/25 hover:text-white"
                        aria-label="Project options"
                      >
                        ⋯
                      </button>

                      {openMenuId === p.id ? (
                        <div className="absolute bottom-full right-0 z-20 mb-2 w-36 rounded-lg border border-white/10 bg-[#111218] p-1 shadow-xl">
                          <button
                            type="button"
                            onClick={() => beginRename(p.id, p.title)}
                            disabled={renamingId === p.id}
                            className="block w-full rounded-md px-3 py-2 text-left text-sm text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteProject(p.id)}
                            disabled={deletingId === p.id}
                            className="block w-full rounded-md px-3 py-2 text-left text-sm text-red-200 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {deletingId === p.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
