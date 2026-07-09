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

function ClockIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 4.6v3.7l2.6 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
  pipeline_stage?: string | null;
  pipeline_stage_label?: string | null;
  pipeline_error?: string | null;
  worker_last_seen_at?: string | null;
};

async function fetchProjectProgress(projectId: string) {
  try {
    const pr = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' });
    const prData = await pr.json();
    if (!pr.ok) return null;
    return {
      id: projectId,
      thumbnail_url: prData?.project?.thumbnail_url ?? null,
      progress_percent: Number(prData?.progress?.percent ?? 0),
      eta_seconds: typeof prData?.progress?.eta_seconds === 'number' ? prData.progress.eta_seconds : null,
      pipeline_status: typeof prData?.project?.pipeline_status === 'string' ? prData.project.pipeline_status : null,
      pipeline_stage: typeof prData?.project?.pipeline_stage === 'string' ? prData.project.pipeline_stage : null,
      pipeline_stage_label: typeof prData?.project?.pipeline_stage_label === 'string' ? prData.project.pipeline_stage_label : null,
      pipeline_error: typeof prData?.project?.pipeline_error === 'string' ? prData.project.pipeline_error : null,
      status: typeof prData?.project?.status === 'string' ? prData.project.status : null,
    };
  } catch {
    return null;
  }
}

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

  function persistProgressFloor() {
    try {
      const payload = JSON.stringify(Object.fromEntries(progressFloorRef.current.entries()));
      sessionStorage.setItem('animacut.dashboard.progressFloor', payload);
    } catch {
      // ignore persistence errors
    }
  }

  function applyProgressFloor(projectId: string, nextPercent: number, status?: string | null) {
    const normalized = Math.max(0, Math.min(100, Number.isFinite(nextPercent) ? nextPercent : 0));
    const previous = progressFloorRef.current.get(projectId) ?? 0;
    const floored = Math.max(previous, normalized);
    const isCompleted = status === 'completed' || floored >= 100;
    progressFloorRef.current.set(projectId, isCompleted ? 100 : floored);
    persistProgressFloor();
    return isCompleted ? 100 : floored;
  }

  function getFlooredProgress(project: ProjectListItem) {
    const direct = Number(project.progress_percent ?? (project.status === 'completed' ? 100 : 0));
    const previous = progressFloorRef.current.get(project.id) ?? 0;
    const active = project.pipeline_status === 'queued' || project.pipeline_status === 'processing';
    if (project.status === 'completed' || project.pipeline_status === 'completed') return 100;
    if (active && previous > 0 && (!Number.isFinite(direct) || direct <= 0)) return previous;
    return Math.max(previous, Math.max(0, Math.min(100, Number.isFinite(direct) ? direct : 0)));
  }

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('animacut.dashboard.progressFloor');
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>;
        progressFloorRef.current = new Map(Object.entries(parsed).map(([key, value]) => [key, Number(value) || 0]));
      }
    } catch {
      // ignore restore errors
    }

    void fetch('/api/projects/repair', { method: 'POST' }).catch(() => null);
  }, []);

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
          const aPercent = getFlooredProgress(a);
          const bPercent = getFlooredProgress(b);
          const aProcessing = (a.pipeline_status === 'queued' || a.pipeline_status === 'processing') && aPercent < 100;
          const bProcessing = (b.pipeline_status === 'queued' || b.pipeline_status === 'processing') && bPercent < 100;

          if (aProcessing !== bProcessing) return aProcessing ? -1 : 1;

          const aTime = new Date(a.created_at).getTime();
          const bTime = new Date(b.created_at).getTime();
          return bTime - aTime;
        });
      };

      const baseProjects = (initial || recentProjects.length === 0)
        ? (projects.map((p) => ({
            ...p,
            thumbnail_url: p.source_thumbnail_url ?? p.thumbnail_url ?? null,
            progress_percent: p.status === 'completed' ? 100 : Math.max(progressFloorRef.current.get(p.id) ?? 0, Number(p.progress_percent ?? 0)),
          })) as ProjectListItem[])
        : recentProjects;

      if (initial || recentProjects.length === 0) {
        const sortedSeeded = sortByQueue(baseProjects);
        setRecentProjects(sortedSeeded);
      }

      const processingIds = (baseProjects.length ? baseProjects : projects)
        .filter((p) => p.pipeline_status === 'queued' || p.pipeline_status === 'processing')
        .slice(0, 3)
        .map((p) => p.id);

      const progressUpdates = await Promise.all(
        processingIds.map(async (id) => {
          const live = await fetchProjectProgress(id);
          if (!live) return null;
          return {
            ...live,
            progress_percent: applyProgressFloor(
              id,
              Number(live.progress_percent ?? 0),
              typeof live.status === 'string' ? live.status : null,
            ),
          };
        }),
      );

      setRecentProjects((prev) => {
        const merged = projects.map((project) => {
          const previous = prev.find((p) => p.id === project.id);
          const update = progressUpdates.find((u) => u?.id === project.id);
          const activeLive = previous && (previous.pipeline_status === 'queued' || previous.pipeline_status === 'processing');

          if (activeLive && !update) {
            return {
              ...project,
              ...previous,
              optimistic: false,
            } as ProjectListItem;
          }

          if (update) {
            const previousProgress = previous ? getFlooredProgress(previous) : 0;
            const incomingProgress = Number(update.progress_percent ?? 0);
            const activeIncoming = update.pipeline_status === 'queued' || update.pipeline_status === 'processing';
            return {
              ...project,
              ...previous,
              ...update,
              thumbnail_url: update.thumbnail_url ?? previous?.thumbnail_url ?? project.thumbnail_url ?? project.source_thumbnail_url ?? null,
              progress_percent: activeIncoming ? Math.max(previousProgress, incomingProgress) : update.progress_percent,
              optimistic: false,
            } as ProjectListItem;
          }

          return {
            ...previous,
            ...project,
            optimistic: false,
          } as ProjectListItem;
        });

        const sortedMerged = sortByQueue(merged);

        hasProcessingRef.current = sortedMerged.some((p) => {
          const pct = getFlooredProgress(p);
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
        await loadProjects();
        const res = await fetch('/api/projects');
        const data = await res.json();
        if (!res.ok) return;
        const createdProject = ((data.projects ?? []) as ProjectListItem[]).find((p) => p.id === createdId);
        if (!createdProject) return;
        const live = await fetchProjectProgress(createdId);

        setRecentProjects((prev) => {
          const withoutDupes = prev.filter((p) => p.id !== createdProject.id);
          return [{ ...createdProject, ...live, optimistic: false }, ...withoutDupes].slice(0, 24);
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
      await fetch('/api/pipeline/process', { method: 'POST' }).catch(() => null);
      await fetch('/api/jobs/process', { method: 'POST' }).catch(() => null);
      await loadProjects();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetch('/api/pipeline/process', { method: 'POST' }).catch(() => null);
        void fetch('/api/jobs/process', { method: 'POST' }).catch(() => null);
        void loadProjects();
      }
    };

    void loadProjects(true);
    void fetch('/api/pipeline/process', { method: 'POST' }).catch(() => null);
    void fetch('/api/jobs/process', { method: 'POST' }).catch(() => null);

    const timer = setInterval(() => {
      void tick();
    }, 3500);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
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

      const percent = getFlooredProgress(p);
      const active = p.pipeline_status === 'queued' || p.pipeline_status === 'processing';
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'processing'
            ? active && percent < 100 && p.status !== 'failed'
            : statusFilter === 'completed'
              ? percent >= 100 || p.status === 'completed' || p.pipeline_status === 'completed'
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
          const isNotEnoughContent = p.pipeline_error === 'not_enough_content';
          const isFailed = (p.pipeline_status === 'error' || p.status === 'failed') && !isNotEnoughContent;
          const percent = isCompleted ? 100 : getFlooredProgress(p);
          const showProcessing = !isCompleted && !isFailed && !isNotEnoughContent && percent < 100;
          const processingStage = p.pipeline_stage_label || (p.pipeline_status === 'queued'
            ? 'Queued'
            : p.pipeline_status === 'processing'
              ? (p.pipeline_stage === 'downloading' ? 'Preparing source video'
                : p.pipeline_stage === 'extracting_audio' ? 'Extracting audio'
                : p.pipeline_stage === 'transcribing' ? 'Transcribing audio'
                : p.pipeline_stage === 'finding_hooks' ? 'Finding hooks'
                : p.pipeline_stage === 'creating_clips' ? 'Creating top clip candidates'
                : p.pipeline_stage === 'rendering' ? 'Rendering clips'
                : p.pipeline_stage === 'uploading_outputs' ? 'Uploading outputs'
                : 'Processing')
              : 'Processing');

          const thumb = (
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black transition duration-300 group-hover:scale-[1.015] group-hover:border-[#9b6bff]/35 group-hover:shadow-[0_0_0_1px_rgba(155,107,255,0.18),0_18px_55px_rgba(102,51,153,0.24)]">
              {p.thumbnail_url || p.source_thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumbnail_url || p.source_thumbnail_url || ''} alt={p.source_title || p.title} className={`aspect-video w-full object-cover ${showProcessing ? 'brightness-[0.82]' : 'brightness-110'}`} loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="grid aspect-video place-items-center bg-white/5 text-xs text-white/55">No thumbnail</div>
              )}

              {showProcessing ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/18">
                  <div className="relative isolate inline-flex min-w-[86px] items-center justify-center overflow-hidden rounded-full border border-emerald-300/25 bg-black/76 px-3 py-2 text-[12px] font-extrabold text-emerald-100 shadow-[0_10px_28px_rgba(0,0,0,0.32)] backdrop-blur-sm">
                    <div
                      className="absolute inset-y-0 left-0 -z-10 bg-emerald-400/35 shadow-[0_0_18px_rgba(52,211,153,0.55)] transition-[width] duration-500 ease-out"
                      style={{ width: `${Math.max(6, Math.min(100, percent))}%` }}
                    />
                    <span>{percent}%</span>
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
                {showProcessing ? (
                  <div className="cursor-wait" aria-disabled="true">{thumb}</div>
                ) : (
                  <Link href={`/dashboard/projects/${p.id}`} prefetch={false}>{thumb}</Link>
                )}

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
                  {isNotEnoughContent ? <p className="mt-1 text-xs text-amber-300/85">No valid clips found</p> : null}
                  {showProcessing ? <p className="mt-1 text-xs text-white/55">{processingStage} · {percent}%</p> : null}
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
