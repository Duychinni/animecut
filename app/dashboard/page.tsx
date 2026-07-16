'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LiveProgressPill } from '@/components/project/LiveProgress';

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
  pipeline_stage?: string | null;
  pipeline_stage_label?: string | null;
  pipeline_error?: string | null;
  worker_last_seen_at?: string | null;
  expires_at?: string | null;
  days_until_expiring?: number | null;
  diagnostics?: ProjectDiagnostics | null;
};

type ProjectDiagnostics = {
  message?: string | null;
  source_type?: string | null;
  transcript_segments?: number | null;
  transcript_seconds?: number | null;
  analyzed_candidates?: number | null;
  done_exports?: number | null;
  active_exports?: number | null;
  failed_exports?: number | null;
  target_exports?: number | null;
  recovery_queued?: boolean | null;
  render_recovery_queued?: boolean | null;
  stale_worker?: boolean | null;
  seconds_since_worker_heartbeat?: number | null;
  latest_pipeline_job?: {
    status?: string | null;
    attempts?: number | null;
    seconds_since_update?: number | null;
    retry_attempt?: number | null;
    retry_of_error?: string | null;
  } | null;
  recent_jobs?: Array<{
    type?: string | null;
    status?: string | null;
    attempts?: number | null;
    seconds_since_update?: number | null;
  }> | null;
  active_export_jobs?: number | null;
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
      worker_last_seen_at: typeof prData?.project?.worker_last_seen_at === 'string' ? prData.project.worker_last_seen_at : null,
      status: typeof prData?.project?.status === 'string' ? prData.project.status : null,
      diagnostics: prData?.diagnostics ?? null,
    };
  } catch {
    return null;
  }
}

function isCompletedProject(project: ProjectListItem) {
  return project.status === 'completed' || project.pipeline_status === 'completed' || Number(project.progress_percent ?? 0) >= 100;
}

function isActiveProject(project: ProjectListItem) {
  if (isCompletedProject(project)) return false;
  if (project.pipeline_error === 'not_enough_content') return false;
  if (project.pipeline_status === 'error' || project.status === 'failed' || project.status === 'error') return false;
  return Boolean(project.optimistic || project.pipeline_status === 'queued' || project.pipeline_status === 'processing');
}

function isFailedProject(project: ProjectListItem) {
  return project.pipeline_status === 'error' || project.status === 'failed' || project.status === 'error';
}

function getExpiryLabel(project: ProjectListItem) {
  if (!isCompletedProject(project)) return null;
  const days = Number(project.days_until_expiring);
  if (!Number.isFinite(days)) return null;
  return `${Math.max(0, days)} ${days === 1 ? 'day' : 'days'} before expiring`;
}

function fmtDebugDuration(totalSec: number | null | undefined) {
  if (typeof totalSec !== 'number' || !Number.isFinite(totalSec)) return 'unknown';
  return fmtDuration(totalSec);
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
  const repairRanRef = useRef(false);
  const loadInFlightRef = useRef(false);

  function persistProgressFloor() {
    try {
      const payload = JSON.stringify(Object.fromEntries(progressFloorRef.current.entries()));
      sessionStorage.setItem('animacut.dashboard.progressFloor', payload);
    } catch {
      // ignore persistence errors
    }
  }

  function getFlooredProgress(project: ProjectListItem) {
    const direct = Number(project.progress_percent ?? (isCompletedProject(project) ? 100 : 0));
    const previous = Math.min(98, progressFloorRef.current.get(project.id) ?? 0);
    const active = isActiveProject(project);
    if (isCompletedProject(project)) return 100;
    if (active && previous > 0 && (!Number.isFinite(direct) || direct <= 0)) return previous;
    return Math.min(98, Math.max(previous, Math.max(0, Math.min(100, Number.isFinite(direct) ? direct : 0))));
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

  }, []);

  async function loadProjects(initial = false) {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    if (initial) setLoadingProjects(true);
    try {
      if (initial && !repairRanRef.current) {
        repairRanRef.current = true;
        void fetch('/api/projects/repair', { method: 'POST', credentials: 'include', cache: 'no-store' }).catch(() => null);
      }

      const res = await fetch('/api/projects', { credentials: 'include', cache: 'no-store' });
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
          const aProcessing = isActiveProject(a) && aPercent < 100;
          const bProcessing = isActiveProject(b) && bPercent < 100;

          if (aProcessing !== bProcessing) return aProcessing ? -1 : 1;

          const aTime = new Date(a.created_at).getTime();
          const bTime = new Date(b.created_at).getTime();
          return bTime - aTime;
        });
      };

      const baseProjects = (initial || recentProjects.length === 0)
        ? (projects.map((p) => {
            const progressPercent = isCompletedProject(p)
              ? 100
              : Math.min(98, Math.max(progressFloorRef.current.get(p.id) ?? 0, Number(p.progress_percent ?? 0)));
            progressFloorRef.current.set(p.id, progressPercent);
            return {
              ...p,
              thumbnail_url: p.source_thumbnail_url ?? p.thumbnail_url ?? null,
              progress_percent: progressPercent,
            };
          }) as ProjectListItem[])
        : recentProjects;

      persistProgressFloor();

      if (initial || recentProjects.length === 0) {
        const sortedSeeded = sortByQueue(baseProjects);
        setRecentProjects(sortedSeeded);
      }

      // The project list endpoint already returns status, stage, progress, and
      // thumbnails. Avoid a second request per project on every dashboard poll.
      const progressUpdates: Array<Awaited<ReturnType<typeof fetchProjectProgress>>> = [];

      setRecentProjects((prev) => {
        const merged = projects.map((project) => {
          const previous = prev.find((p) => p.id === project.id);
          const update = progressUpdates.find((u) => u?.id === project.id);
          if (update) {
            const previousProgress = previous ? getFlooredProgress(previous) : 0;
            const incomingProgress = Number(update.progress_percent ?? 0);
            const activeIncoming = isActiveProject({ ...project, ...previous, ...update } as ProjectListItem);
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
          return isActiveProject(p) && pct < 100;
        });

        return sortedMerged;
      });
    } finally {
      loadInFlightRef.current = false;
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
        const res = await fetch('/api/projects', { credentials: 'include', cache: 'no-store' });
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
      await loadProjects();
      void Promise.allSettled([
        fetch('/api/pipeline/process', { method: 'POST' }),
        fetch('/api/jobs/process', { method: 'POST' }),
      ]);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadProjects();
      }
    };

    void loadProjects(true);

    const timer = setInterval(() => {
      void tick();
    }, 5000);
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
        credentials: 'include',
        cache: 'no-store',
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
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE', credentials: 'include', cache: 'no-store' });
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

  function buildProjectDebugText(project: ProjectListItem) {
    const d = project.diagnostics;
    const job = d?.latest_pipeline_job;
    const recentJobs = (d?.recent_jobs ?? [])
      .map((item) => `${item.type || 'job'}:${item.status || 'unknown'}:${fmtDebugDuration(item.seconds_since_update)} ago:a${item.attempts ?? 0}`)
      .join(', ');

    return [
      `Project: ${project.id}`,
      `Title: ${project.source_title || project.title}`,
      `Source: ${project.source_type}`,
      `Status: ${project.status}`,
      `Pipeline: ${project.pipeline_status || 'unknown'} / ${project.pipeline_stage || 'unknown'} / ${project.pipeline_stage_label || 'no label'}`,
      `Progress: ${getFlooredProgress(project)}%`,
      `Error: ${project.pipeline_error || 'none'}`,
      `Message: ${d?.message || 'none'}`,
      `Worker heartbeat: ${fmtDebugDuration(d?.seconds_since_worker_heartbeat)} ago`,
      `Pipeline job: ${job?.status || 'none'}, attempts ${job?.attempts ?? 0}, updated ${fmtDebugDuration(job?.seconds_since_update)} ago`,
      `Retry: ${job?.retry_attempt ?? 'none'} ${job?.retry_of_error || ''}`.trim(),
      `Transcript: ${d?.transcript_segments ?? 'unknown'} segments, ${fmtDebugDuration(d?.transcript_seconds)} duration`,
      `Candidates: ${d?.analyzed_candidates ?? 'unknown'}`,
      `Exports: done ${d?.done_exports ?? 0}, active ${d?.active_exports ?? 0}, failed ${d?.failed_exports ?? 0}, target ${d?.target_exports ?? 'unknown'}`,
      `Recovery: pipeline ${d?.recovery_queued ? 'yes' : 'no'}, render ${d?.render_recovery_queued ? 'yes' : 'no'}, stale ${d?.stale_worker ? 'yes' : 'no'}`,
      `Recent jobs: ${recentJobs || 'none'}`,
    ].join('\n');
  }

  async function copyProjectDebug(project: ProjectListItem) {
    const debugText = buildProjectDebugText(project);
    try {
      await navigator.clipboard.writeText(debugText);
      setMsg('Copied project debug details.');
    } catch {
      setMsg(debugText);
    }
  }

  const orderedProjects = [...recentProjects]
    .filter((p) => {
      const matchesSearch = searchQuery.trim() ? (p.source_title || p.title).toLowerCase().includes(searchQuery.trim().toLowerCase()) : true;

      const percent = getFlooredProgress(p);
      const active = isActiveProject(p);
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
          const isCompleted = isCompletedProject(p);
          const isNotEnoughContent = p.pipeline_error === 'not_enough_content';
          const isFailed = isFailedProject(p) && !isNotEnoughContent;
          const percent = isCompleted ? 100 : getFlooredProgress(p);
          const showProcessing = isActiveProject(p) && !isFailed && !isNotEnoughContent && percent < 100;
          // A saved project must always remain openable. Its project page owns the
          // processing, recovery, failure, and completed views. Only the temporary
          // optimistic card lacks a stable route while the project is being created.
          const canOpenProject = !p.optimistic;
          const isPaused = !isCompleted && !showProcessing && !isFailed && !isNotEnoughContent && !p.optimistic;
          const expiryLabel = getExpiryLabel(p);
          const rawProcessingStage = p.pipeline_stage_label || (p.pipeline_status === 'queued'
            ? 'Queued'
            : p.pipeline_status === 'processing'
              ? (p.pipeline_stage === 'downloading' ? 'Preparing source video'
                : p.pipeline_stage === 'extracting_audio' ? 'Extracting audio'
                : p.pipeline_stage === 'transcribing' ? 'Transcribing audio'
                : p.pipeline_stage === 'diarizing' ? 'Identifying speakers'
                : p.pipeline_stage === 'finding_hooks' ? 'Finding hooks'
                : p.pipeline_stage === 'creating_clips' ? 'Creating top clip candidates'
                : p.pipeline_stage === 'rendering' ? 'Rendering clips'
                : p.pipeline_stage === 'uploading_outputs' ? 'Finalizing reels'
                : 'Processing')
              : 'Processing');
          const processingStage = /uploading (final clips|outputs)/i.test(rawProcessingStage) ? 'Finalizing reels' : rawProcessingStage;
          const diagnostics = p.diagnostics;
          const pipelineJob = diagnostics?.latest_pipeline_job ?? null;
          const showDebug = false;
          const etaLabel = showProcessing && typeof p.eta_seconds === 'number' && Number.isFinite(p.eta_seconds) && p.eta_seconds > 0
            ? `Approx. ETA ${fmtDuration(p.eta_seconds)}`
            : null;
          const debugLine = diagnostics
            ? `${diagnostics.message || 'Waiting for backend update'} Last worker ${fmtDebugDuration(diagnostics.seconds_since_worker_heartbeat)} ago. Job ${pipelineJob?.status || 'none'}${pipelineJob?.attempts ? ` a${pipelineJob.attempts}` : ''}.`
            : null;

          const thumb = (
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black transition duration-300 group-hover:scale-[1.015] group-hover:border-[#9b6bff]/35 group-hover:shadow-[0_0_0_1px_rgba(155,107,255,0.18),0_18px_55px_rgba(102,51,153,0.24)]">
              {p.thumbnail_url || p.source_thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumbnail_url || p.source_thumbnail_url || ''} alt={p.source_title || p.title} className={`aspect-video w-full object-cover ${showProcessing ? 'brightness-[0.82]' : 'brightness-110'}`} loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="grid aspect-video place-items-center bg-white/5 text-xs text-white/55">No thumbnail</div>
              )}

              {expiryLabel ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-black/55 px-3 py-1.5 text-center text-[12px] font-medium text-white/85 backdrop-blur-sm">
                  {expiryLabel}
                </div>
              ) : null}

              {showProcessing ? (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/18">
                  <LiveProgressPill percent={percent} active stage={p.pipeline_stage} stageLabel={processingStage} etaLabel={etaLabel} />
                </div>
              ) : canOpenProject ? (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-start opacity-0 transition duration-300 group-hover:opacity-100">
                  <div className="m-3 rounded-full border border-[#9b6bff]/35 bg-black/55 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/95 backdrop-blur-sm">
                    Open Project
                  </div>
                </div>
              ) : null}
            </div>
          );

          return (
            <div key={p.id} className="group rounded-2xl bg-transparent p-4 transition hover:bg-white/[0.02]">
              <div className="min-w-0">
                {!canOpenProject ? (
                  <div className="cursor-pointer" aria-disabled="true">{thumb}</div>
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
                  {isNotEnoughContent ? <p className="mt-1 text-xs text-amber-300/85">No valid clips found · open project for details</p> : null}
                  {isFailed ? <p className="mt-1 text-xs text-red-300/85">Rendering stopped · open project to review or retry</p> : null}
                  {isPaused ? <p className="mt-1 text-xs text-amber-200/75">Project paused · open project to continue</p> : null}
                  {showProcessing ? <p className="mt-1 text-xs text-white/55">{processingStage} · {percent}%{etaLabel ? ` · ${etaLabel}` : ''}</p> : null}
                  {showDebug ? (
                    <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.035] p-2 text-[11px] leading-4 text-white/55">
                      <p className="line-clamp-2">{debugLine}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-white/45">
                        <span>Candidates {diagnostics?.analyzed_candidates ?? 0}</span>
                        <span>Exports {diagnostics?.done_exports ?? 0}/{diagnostics?.target_exports ?? 0}</span>
                        <span>Active {diagnostics?.active_exports ?? 0}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyProjectDebug(p)}
                        className="mt-1 text-[11px] font-semibold text-emerald-300 transition hover:text-emerald-200"
                      >
                        Copy debug
                      </button>
                    </div>
                  ) : null}
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
