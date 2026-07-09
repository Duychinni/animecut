'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { readJsonSafe } from '@/lib/safe-json';

type ProgressPayload = {
  project?: {
    id: string;
    title: string;
    status: string;
    pipeline_status?: string | null;
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
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function ClockIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 4.6v3.7l2.6 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PipelineRunner({ projectId, autoStart = false }: { projectId: string; autoStart?: boolean }) {
  const router = useRouter();
  const [log, setLog] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const autoRanRef = useRef(false);
  const processingKickInFlightRef = useRef(false);

  const progressPct = useMemo(() => Math.max(0, Math.min(100, Number(progress?.progress?.percent ?? 0))), [progress]);
  const activeExportCount = useMemo(() => Number(progress?.progress?.active_exports ?? 0), [progress]);
  const isCompleted = progress?.project?.status === 'completed';

  const refreshProgress = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' });
      const data = (await readJsonSafe(res)) as ProgressPayload;
      if (res.ok) setProgress(data);
    } catch {
      // ignore transient polling failures
    }
  }, [projectId]);

  const kickBackgroundProcessing = useCallback(async () => {
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
    if (progressPct >= 100 && activeExportCount <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      await refreshProgress();

      const pipelineStatus = progress?.project?.pipeline_status ?? 'idle';
      const activeExports = Number(progress?.progress?.active_exports ?? 0);
      const doneExports = Number(progress?.progress?.done_exports ?? 0);

      if (pipelineStatus === 'queued' || pipelineStatus === 'processing' || activeExports > 0 || doneExports === 0) {
        await kickBackgroundProcessing();
      }
    };

    void tick();
    timer = setInterval(() => {
      void tick();
    }, 4000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [activeExportCount, kickBackgroundProcessing, refreshProgress, progressPct, progress]);

  useEffect(() => {
    if (!autoStart || autoRanRef.current || loading) return;
    autoRanRef.current = true;
    void runPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useEffect(() => {
    void fetch('/api/projects/repair', { method: 'POST' }).catch(() => null);
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
                {progressPct}%
              </div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-white/75">
                {isCompleted ? 'Completed' : 'Processing'}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-[width] duration-500 ease-out"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
