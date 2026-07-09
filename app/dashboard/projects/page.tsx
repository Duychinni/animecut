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
  pipeline_status?: string | null;
  pipeline_stage?: string | null;
  pipeline_stage_label?: string | null;
};

function ClockIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 4.6v3.7l2.6 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
              status: String(prData?.project?.status ?? p.status),
              thumbnail_url: prData?.project?.thumbnail_url ?? null,
              progress_percent: Number(prData?.progress?.percent ?? 0),
              eta_seconds: typeof prData?.progress?.eta_seconds === 'number' ? prData.progress.eta_seconds : null,
              pipeline_status: typeof prData?.project?.pipeline_status === 'string' ? prData.project.pipeline_status : null,
              pipeline_stage: typeof prData?.project?.pipeline_stage === 'string' ? prData.project.pipeline_stage : null,
              pipeline_stage_label: typeof prData?.project?.pipeline_stage_label === 'string' ? prData.project.pipeline_stage_label : null,
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
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Projects</h1>
          <p className="mt-1 text-sm text-white/60">Click a thumbnail to reopen its saved clips.</p>
        </div>
        <Link href="/dashboard" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">
          Back to Dashboard
        </Link>
      </div>

      {msg ? <p className="mb-4 text-sm text-white/75">{msg}</p> : null}

      {loadingProjects && <p className="text-sm text-white/60">Loading projects...</p>}
      {!loadingProjects && !recentProjects.length && <p className="text-sm text-white/60">No projects yet.</p>}

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {recentProjects.map((p) => {
          const percent = Math.max(0, Math.min(100, Number(p.progress_percent ?? (p.status === 'completed' ? 100 : 0))));
          const showProcessing = p.status !== 'completed';
          const processingStage = p.pipeline_stage_label || (p.pipeline_status === 'queued'
            ? 'Queued'
            : p.pipeline_stage === 'downloading' ? 'Preparing source video'
            : p.pipeline_stage === 'extracting_audio' ? 'Extracting audio'
            : p.pipeline_stage === 'transcribing' ? 'Transcribing audio'
            : p.pipeline_stage === 'finding_hooks' ? 'Finding hooks'
            : p.pipeline_stage === 'creating_clips' ? 'Creating top clip candidates'
            : p.pipeline_stage === 'rendering' ? 'Rendering clips'
            : p.pipeline_stage === 'uploading_outputs' ? 'Uploading outputs'
            : 'Processing');

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
                  <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/18">
                    <div className="relative isolate flex min-w-[150px] flex-col items-center justify-center gap-0.5 overflow-hidden rounded-full border border-emerald-300/25 bg-black/76 px-3 py-2 text-center text-emerald-100 shadow-[0_10px_28px_rgba(0,0,0,0.32)] backdrop-blur-sm">
                      <div
                        className="absolute inset-y-0 left-0 -z-10 bg-emerald-400/35 shadow-[0_0_18px_rgba(52,211,153,0.55)] transition-[width] duration-500 ease-out"
                        style={{ width: `${Math.max(6, Math.min(100, percent))}%` }}
                      />
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-extrabold leading-none">
                        <ClockIcon className="h-3.5 w-3.5" />
                        {percent}%
                      </span>
                      <span className="max-w-[132px] truncate text-[9px] font-black uppercase tracking-[0.08em] text-emerald-50/85">{processingStage}</span>
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
            <div key={p.id} className="group rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-white/25 hover:bg-white/[0.05] backdrop-blur-sm">
              <div className="flex items-start justify-between gap-3">
                {showProcessing ? (
                  <div className="min-w-0 flex-1 cursor-pointer opacity-95">{cardBody}</div>
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
