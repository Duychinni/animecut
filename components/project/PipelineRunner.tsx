'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { readJsonSafe } from '@/lib/safe-json';
import { formatLivePercent, useLiveProgress } from '@/components/project/LiveProgress';
import { createClient } from '@/lib/supabase/client';
import { captureEvent } from '@/lib/analytics';

const CLIENT_WORKER_KICKS_ENABLED = process.env.NEXT_PUBLIC_CLIENT_WORKER_KICKS === 'true';

type ProgressPayload = {
  project?: {
    id: string;
    title: string;
    status: string;
    pipeline_status?: string | null;
    pipeline_stage?: string | null;
    pipeline_stage_label?: string | null;
    pipeline_error?: string | null;
    source_type: 'youtube' | 'upload' | string;
    source_url: string | null;
    thumbnail_url: string | null;
    created_at?: string;
    updated_at?: string;
  };
  progress?: {
    percent: number;
    done_exports: number;
    active_exports: number;
    target_exports: number;
    elapsed_seconds: number;
    eta_seconds: number | null;
  };
};

function fmtDuration(totalSec: number | null | undefined) {
  if (typeof totalSec !== 'number' || !Number.isFinite(totalSec)) return '—';
  const minutes = Math.max(1, Math.ceil(totalSec / 60));
  return `${minutes} min`;
}

function ClockIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 4.6v3.7l2.6 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function getProcessingLabel(stage?: string | null) {
  switch (stage) {
    case 'queued':
      return 'Queued';
    case 'downloading':
      return 'Preparing source';
    case 'extracting_audio':
      return 'Extracting audio';
    case 'transcribing':
      return 'Transcribing audio';
    case 'finding_hooks':
      return 'Finding hooks';
    case 'creating_clips':
      return 'Creating clips';
    case 'face_tracking_crop':
      return 'Framing clips';
    case 'rendering':
      return 'Rendering reels';
    case 'uploading_outputs':
      return 'Finalizing reels';
    default:
      return 'Processing';
  }
}

export function PipelineRunner({ projectId, autoStart = false }: { projectId: string; autoStart?: boolean }) {
  const router = useRouter();
  const [log, setLog] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const progressRef = useRef<ProgressPayload | null>(null);
  const autoRanRef = useRef(false);
  const processingKickInFlightRef = useRef(false);
  const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionTrackedRef = useRef(false);

  const progressPct = useMemo(() => Math.max(0, Math.min(100, Number(progress?.progress?.percent ?? 0))), [progress]);
  const isCompleted = progress?.project?.status === 'completed';
  const liveProgressPct = useLiveProgress(progressPct, !isCompleted, progress?.project?.pipeline_stage);

  useEffect(() => {
    if (!isCompleted || completionTrackedRef.current) return;
    completionTrackedRef.current = true;
    captureEvent('analysis_completed', { project_id: projectId });
  }, [isCompleted, projectId]);

  const refreshProgress = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' });
      const data = (await readJsonSafe(res)) as ProgressPayload;
      if (res.ok) {
        progressRef.current = data;
        setProgress(data);
        return data;
      }
    } catch {
      // ignore transient polling failures
    }
    return null;
  }, [projectId]);

  const kickBackgroundProcessing = useCallback(async () => {
    if (!CLIENT_WORKER_KICKS_ENABLED) return;
    if (processingKickInFlightRef.current) return;
    processingKickInFlightRef.current = true;
    try {
      await fetch('/api/pipeline/process', { method: 'POST' });
      await fetch('/api/jobs/process', { method: 'POST' });
    } catch {
      // best effort only
    } finally {
      processingKickInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const scheduleRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
      realtimeRefreshTimerRef.current = setTimeout(() => {
        void refreshProgress().then((latest) => {
          if (latest?.project?.status === 'completed') router.refresh();
        });
      }, 150);
    };

    const channel = supabase
      .channel(`project-processing-${projectId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'projects', filter: `id=eq.${projectId}` },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'exports', filter: `project_id=eq.${projectId}` },
        scheduleRefresh,
      )
      .subscribe();

    return () => {
      if (realtimeRefreshTimerRef.current) clearTimeout(realtimeRefreshTimerRef.current);
      void supabase.removeChannel(channel);
    };
  }, [projectId, refreshProgress, router]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const latestProgress = await refreshProgress();
      const snapshot = latestProgress ?? progressRef.current;

      const projectStatus = snapshot?.project?.status ?? 'created';
      const pipelineStatus = snapshot?.project?.pipeline_status ?? 'idle';
      const pipelineError = snapshot?.project?.pipeline_error;
      const activeExports = Number(snapshot?.progress?.active_exports ?? 0);
      const doneExports = Number(snapshot?.progress?.done_exports ?? 0);

      if (projectStatus === 'completed' || pipelineStatus === 'completed' || pipelineError) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        return;
      }

      if (pipelineStatus === 'queued' || pipelineStatus === 'processing' || activeExports > 0 || doneExports === 0) {
        await kickBackgroundProcessing();
      }
    };

    void tick();
    timer = setInterval(() => {
      void tick();
    }, 30_000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [kickBackgroundProcessing, refreshProgress]);

  useEffect(() => {
    if (!autoStart || autoRanRef.current || loading) return;
    autoRanRef.current = true;
    void runPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useEffect(() => {
    if (CLIENT_WORKER_KICKS_ENABLED) {
      void fetch('/api/projects/repair', { method: 'POST' }).catch(() => null);
    }
  }, []);

  useEffect(() => {
    if (autoRanRef.current || loading) return;
    if (!progress?.project) return;

    const isIdle = (progress.project.pipeline_status ?? 'idle') === 'idle';
    const isNotDone = progress.project.status !== 'completed';

    if (isIdle && isNotDone) {
      autoRanRef.current = true;
      void runPipeline();
    }
  }, [loading, progress]);

  async function runPipeline() {
    setLoading(true);
    setLog('Starting pipeline...');

    try {
      const start = await fetch(`/api/projects/${projectId}/start`, { method: 'POST' });
      const startData = await readJsonSafe(start);
      if (!start.ok) {
        setLog(`Start failed: ${String(startData.error || 'unknown')}`);
        setLoading(false);
        return;
      }

      setLog('Pipeline queued. Reattaching to progress...');
      await kickBackgroundProcessing();
      await refreshProgress();
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const thumbnailUrl = progress?.project?.thumbnail_url;
  const processingLabel = progress?.project?.pipeline_stage_label || getProcessingLabel(progress?.project?.pipeline_stage);
  const etaSeconds = progress?.progress?.eta_seconds ?? null;
  const etaLabel = typeof etaSeconds === 'number' && Number.isFinite(etaSeconds) && etaSeconds > 0 ? `ETA ${fmtDuration(etaSeconds)}` : null;

  if (isCompleted) {
    return null;
  }

  return (
    <div className="w-full">
      <span className="sr-only" aria-live="polite">{log}</span>
      <div className="grid gap-3 md:grid-cols-[260px_1fr]">
        <div className="relative overflow-hidden rounded-xl border border-white/15 bg-black/40 p-2">
          {thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbnailUrl} alt="Source thumbnail" className="h-32 w-full rounded-md object-cover opacity-90" loading="eager" referrerPolicy="no-referrer" />
          ) : (
            <div className="grid h-32 place-items-center rounded-md bg-white/5 text-xs text-white/50">Source media</div>
          )}

          <div className="absolute inset-0 grid place-items-center bg-black/45">
            <div className="w-[78%] max-w-[240px] rounded-lg border border-white/25 bg-black/60 px-4 py-3 text-center backdrop-blur-sm">
              <div className="inline-flex items-center justify-center gap-2 text-2xl font-bold text-white">
                <ClockIcon className="h-5 w-5 text-emerald-300" />
                {formatLivePercent(liveProgressPct)}%
              </div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-white/75">
                {isCompleted ? 'Completed' : processingLabel}
              </div>
              {etaLabel ? <div className="mb-2 text-[11px] font-semibold text-emerald-100/85">{etaLabel}</div> : null}
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/20">
                <div
                  className="relative h-full overflow-hidden rounded-full bg-emerald-400 transition-[width] duration-500 ease-linear"
                  style={{ width: `${liveProgressPct}%` }}
                >
                  {!isCompleted ? <span className="progress-active-sheen absolute inset-y-0 block w-10 bg-gradient-to-r from-transparent via-white/40 to-transparent" /> : null}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
