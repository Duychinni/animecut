'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type ProgressPayload = {
  project?: {
    id: string;
    title: string;
    status: string;
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

export function PipelineRunner({ projectId, autoStart = false }: { projectId: string; autoStart?: boolean }) {
  const router = useRouter();
  const [log, setLog] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const autoRanRef = useRef(false);

  const progressPct = useMemo(() => Math.max(0, Math.min(100, Number(progress?.progress?.percent ?? 0))), [progress]);
  const isCompleted = progress?.project?.status === 'completed' || progressPct >= 100;

  const refreshProgress = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' });
      const data = (await res.json()) as ProgressPayload;
      if (res.ok) setProgress(data);
    } catch {
      // ignore transient polling failures
    }
  }, [projectId]);

  useEffect(() => {
    if (progressPct >= 100) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      await refreshProgress();
    };

    void tick();
    timer = setInterval(() => {
      void tick();
    }, 3000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [refreshProgress, progressPct]);

  useEffect(() => {
    if (!autoStart || autoRanRef.current || loading) return;
    autoRanRef.current = true;
    void runPipeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  async function runPipeline() {
    setLoading(true);
    setLog('Transcribing...');

    const t = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    const tData = await t.json();
    if (!t.ok) {
      setLog(`Transcribe failed: ${tData.error || 'unknown'}`);
      setLoading(false);
      return;
    }

    await refreshProgress();
    setLog('Analyzing top clips...');
    const a = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    const aData = await a.json();
    if (!a.ok) {
      setLog(`Analyze failed: ${aData.error || 'unknown'}`);
      setLoading(false);
      return;
    }

    await refreshProgress();
    setLog('Queueing Animacut smart clip set...');
    let totalProcessed = 0;

    for (let round = 0; round < 8; round += 1) {
      const q = await fetch('/api/clips/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
        }),
      });
      const qData = await q.json();
      if (!q.ok) {
        setLog(`Queue failed: ${qData.error || 'unknown'}`);
        setLoading(false);
        return;
      }

      setLog(`Rendering clips... (pass ${round + 1})`);
      let idlePasses = 0;

      for (let i = 0; i < 10; i += 1) {
        const p = await fetch('/api/jobs/process', { method: 'POST' });
        const pData = await p.json();
        if (!p.ok) {
          setLog(`Render failed: ${pData.error || 'unknown'}`);
          setLoading(false);
          return;
        }

        const processed = Number(pData.processed ?? 0);
        totalProcessed += processed;
        await refreshProgress();

        if (processed === 0) {
          idlePasses += 1;
          if (idlePasses >= 3) break;
          await new Promise((r) => setTimeout(r, 800));
        } else {
          idlePasses = 0;
        }
      }

      if (Number(qData.queued ?? 0) === 0) {
        break;
      }
    }

    // Final drain: keep draining while there are still active/incomplete exports.
    // This avoids the common "stuck at ~93%" case where one last job is still pending.
    const drainDeadline = Date.now() + 4 * 60 * 1000; // max 4 min safety cap
    let idleRounds = 0;

    while (Date.now() < drainDeadline) {
      let done = 0;
      let target = 5;
      let active = 0;

      try {
        const pr = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' });
        const prData = (await pr.json()) as ProgressPayload;
        done = Number(prData?.progress?.done_exports ?? 0);
        target = Number(prData?.progress?.target_exports ?? 5);
        active = Number(prData?.progress?.active_exports ?? 0);
      } catch {
        // continue drain attempts
      }

      if (done >= target && active <= 0) {
        break;
      }

      setLog(`Rendering clips... (${done}/${target}${active > 0 ? `, active ${active}` : ''})`);

      const p = await fetch('/api/jobs/process', { method: 'POST' });
      if (!p.ok) break;

      const pData = await p.json();
      const processed = Number(pData.processed ?? 0);
      totalProcessed += processed;

      await refreshProgress();

      if (processed === 0) {
        idleRounds += 1;
        if (idleRounds >= 12 && active <= 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        idleRounds = 0;
      }
    }

    await refreshProgress();
    const finalRes = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' }).catch(() => null);
    const finalData = finalRes ? ((await finalRes.json()) as ProgressPayload) : null;
    const finalDone = Number(finalData?.progress?.done_exports ?? 0);
    const finalTarget = Number(finalData?.progress?.target_exports ?? 5);

    if (finalDone < finalTarget) {
      setLog(`Almost done: ${finalDone}/${finalTarget} rendered. Last clip is still finalizing in queue.`);
    } else {
      setLog(`Done. Generated ${aData.count ?? 0} candidates and rendered ${totalProcessed} clip(s).`);
    }

    router.refresh();
    setLoading(false);
  }

  const thumbnailUrl = progress?.project?.thumbnail_url;

  return (
    <div className="w-full">
      <span className="sr-only" aria-live="polite">{log}</span>
      <div className="grid gap-3 md:grid-cols-[260px_1fr]">
        <div className="relative overflow-hidden rounded-xl border border-white/15 bg-black/40 p-2">
          {thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbnailUrl} alt="Source thumbnail" className="h-32 w-full rounded-md object-cover opacity-80" />
          ) : (
            <div className="grid h-32 place-items-center rounded-md bg-white/5 text-xs text-white/50">Source media</div>
          )}

          <div className="absolute inset-0 grid place-items-center bg-black/45">
            <div className="w-[78%] max-w-[240px] rounded-lg border border-white/25 bg-black/60 px-4 py-3 text-center backdrop-blur-sm">
              <div className="text-2xl font-bold text-white">{progressPct}%</div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-white/75">
                {isCompleted ? 'Completed' : `Processing · ETA ${fmtDuration(progress?.progress?.eta_seconds ?? null)}`}
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
