'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
  optimistic?: boolean;
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
  pipeline_status?: string | null;
};

export default function DashboardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const progressFloorRef = useRef<Map<string, number>>(new Map());
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  function applyProgressFloor(projectId: string, nextPercent: number, status?: string | null) {
    const normalized = Math.max(0, Math.min(100, Number.isFinite(nextPercent) ? nextPercent : 0));
    const previous = progressFloorRef.current.get(projectId) ?? 0;
    const floored = Math.max(previous, normalized);
    const isCompleted = status === 'completed' || floored >= 100;
    progressFloorRef.current.set(projectId, isCompleted ? 100 : floored);
    return isCompleted ? 100 : floored;
  }

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

      const sortByQueue = (items: ProjectListItem[]) => {
        return [...items].sort((a, b) => {
          const aPercent = Number(a.progress_percent ?? (a.status === 'completed' ? 100 : 0));
          const bPercent = Number(b.progress_percent ?? (b.status === 'completed' ? 100 : 0));
          const aProcessing = aPercent < 100;
          const bProcessing = bPercent < 100;

          if (aProcessing !== bProcessing) return aProcessing ? -1 : 1;

          const aTime = new Date(a.created_at).getTime();
          const bTime = new Date(b.created_at).getTime();
          return bTime - aTime;
        });
      };

      if (initial || recentProjects.length === 0) {
        const seeded = projects.map((p) => ({
          ...p,
          thumbnail_url: p.source_thumbnail_url ?? p.thumbnail_url ?? null,
          progress_percent: p.status === 'completed' ? 100 : p.progress_percent,
        })) as ProjectListItem[];

        const sortedSeeded = sortByQueue(seeded);

        hasProcessingRef.current = sortedSeeded.some((p) => {
          const pct = Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0));
          return pct < 100;
        });

        setRecentProjects(sortedSeeded);
        return;
      }

      const processingIds = projects
        .filter((p) => p.status !== 'completed')
        .slice(0, 6)
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
              progress_percent: applyProgressFloor(
                id,
                Number(prData?.progress?.percent ?? 0),
                typeof prData?.project?.status === 'string' ? prData.project.status : null,
              ),
              eta_seconds: typeof prData?.progress?.eta_seconds === 'number' ? prData.progress.eta_seconds : null,
              pipeline_status: typeof prData?.project?.pipeline_status === 'string' ? prData.project.pipeline_status : null,
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

        const sortedMerged = sortByQueue(merged);

        hasProcessingRef.current = sortedMerged.some((p) => {
          const pct = Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0));
          return pct < 100;
        });

        return sortedMerged;
      });
    } finally {
      if (initial) setLoadingProjects(false);
    }
  }

  useEffect(() => {
    const createdId = searchParams.get('created');
    if (!createdId) return;

    setRecentProjects((prev) => {
      if (prev.some((p) => p.id === createdId)) return prev;
      const optimisticProject: ProjectListItem = {
        id: createdId,
        title: 'New project',
        status: 'created',
        optimistic: true,
        source_type: 'upload',
        created_at: new Date().toISOString(),
        progress_percent: 5,
        pipeline_status: 'queued',
      };
      return [optimisticProject, ...prev].slice(0, 24);
    });

    void (async () => {
      try {
        const res = await fetch('/api/projects');
        const data = await res.json();
        if (!res.ok) return;
        const createdProject = ((data.projects ?? []) as ProjectListItem[]).find((p) => p.id === createdId);
        if (!createdProject) return;

        setRecentProjects((prev) => {
          const withoutDupes = prev.filter((p) => p.id !== createdProject.id);
          return [{ ...createdProject, optimistic: false }, ...withoutDupes].slice(0, 24);
        });
      } catch {
        // best effort only
      }
    })();
  }, [searchParams]);

  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      if (!hasProcessingRef.current) return;
      await loadProjects();
    };

    void loadProjects(true);

    const timer = setInterval(() => {
      void tick();
    }, 4000);

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
          const isCompleted = p.status === 'completed' || p.pipeline_status === 'completed';
          const percent = isCompleted ? 100 : Math.max(0, Math.min(100, Number(p.progress_percent ?? 0)));
          const showProcessing = !isCompleted && percent < 100;
          const processingStage = p.pipeline_status === 'queued'
            ? 'Finding hooks...'
            : p.pipeline_status === 'processing'
              ? (percent < 45 ? 'Finding hooks...' : percent < 70 ? 'Scoring moments...' : percent < 92 ? 'Rendering captions...' : 'Generating thumbnails...')
              : 'Processing';
          const processingLabel = `${processingStage} ${percent}%`;

          const thumb = (
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black transition duration-300 group-hover:scale-[1.015] group-hover:border-[#9b6bff]/35 group-hover:shadow-[0_0_0_1px_rgba(155,107,255,0.18),0_18px_55px_rgba(102,51,153,0.24)]">
              {p.thumbnail_url || p.source_thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumbnail_url || p.source_thumbnail_url || ''} alt={p.source_title || p.title} className={`aspect-video w-full object-cover ${showProcessing ? 'brightness-[0.82]' : 'brightness-110'}`} loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="grid aspect-video place-items-center bg-white/5 text-xs text-white/55">No thumbnail</div>
              )}

              {showProcessing ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/24 px-4 text-center">
                  <div className="rounded-[16px] border border-white/12 bg-black/52 px-3.5 py-2.5 text-white shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-sm">
                    <div className="text-[1.55rem] font-extrabold leading-none tracking-tight">{percent}%</div>
                    <div className="mt-2 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/85">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                      {processingStage}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="pointer-events-none absolute inset-0 flex items-end justify-start opacity-0 transition duration-300 group-hover:opacity-100">
                  <div className="m-3 rounded-full border border-[#9b6bff]/35 bg-black/55 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/95 backdrop-blur-sm">
                    Open Project
                  </div>
                </div>
              )}
            </div>
          );

          return (
            <div key={p.id} className="group rounded-2xl bg-transparent p-4 transition hover:bg-white/[0.02]">
              <div className="min-w-0">
                <Link href={`/dashboard/projects/${p.id}`} prefetch>{thumb}</Link>

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
                  {p.optimistic ? <p className="mt-1 text-xs text-emerald-300/80">Starting project…</p> : null}
                  <div className="mt-1 flex items-end justify-between gap-3">
                    <p className="text-xs text-white/50">
                      {p.source_channel_name ? `${p.source_channel_name} · ` : ''}{p.source_type.toUpperCase()} · {new Date(p.created_at).toLocaleDateString()}
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
