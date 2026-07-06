'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type ProgressPayload = {
  project?: {
    id: string;
    status: string;
    pipeline_status?: string | null;
    pipeline_error?: string | null;
  };
  progress?: {
    percent: number;
    eta_seconds: number | null;
    target_exports: number;
  };
};

function getProcessingLabel(status: string) {
  if (status === 'created') return 'Finding hooks...';
  if (status === 'transcribed') return 'Scoring moments...';
  if (status === 'analyzed') return 'Rendering captions and generating thumbnails...';
  if (status === 'completed') return 'Completed';
  return 'Processing your video';
}

export function ProcessingHero({ projectId, pageTitle, heroThumbnail, fallbackPercent, fallbackTargetCount }: {
  projectId: string;
  pageTitle: string;
  heroThumbnail: string | null;
  fallbackPercent: number;
  fallbackTargetCount: number;
}) {
  const router = useRouter();
  const [data, setData] = useState<ProgressPayload | null>(null);
  const completedNavRef = useRef(false);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' });
        const json = (await res.json()) as ProgressPayload;
        if (!alive || !res.ok) return;
        setData(json);
      } catch {
        // ignore transient errors
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 1500);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);

  const percent = Math.max(0, Math.min(100, Number(data?.progress?.percent ?? fallbackPercent)));
  const status = String(data?.project?.status ?? 'created');
  const pipelineError = data?.project?.pipeline_error ?? null;

  useEffect(() => {
    if (completedNavRef.current) return;
    if (status === 'completed') {
      completedNavRef.current = true;
      router.replace(`/dashboard/projects/${projectId}?done=${Date.now()}`);
    }
  }, [projectId, router, status]);

  return (
    <div className="flex min-h-[68vh] w-full items-start justify-center">
      <div className="w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/10 bg-[#0d0f14] shadow-[0_30px_120px_rgba(0,0,0,0.45)]">
        <div className="grid min-h-[560px] lg:grid-cols-[1.2fr_0.8fr]">
          <div className="relative bg-black">
            {heroThumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={heroThumbnail} alt={pageTitle} className="h-full w-full object-cover brightness-110" loading="eager" referrerPolicy="no-referrer" />
            ) : (
              <div className="grid h-full min-h-[320px] place-items-center bg-white/5 text-sm text-white/50">Preparing preview...</div>
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-black/20 via-black/25 to-black/70" />
          </div>

          <div className="flex flex-col justify-center px-8 py-10 lg:px-10">
            <p className="text-sm uppercase tracking-[0.22em] text-white/45">Processing project</p>
            <h2 className="mt-4 text-3xl font-semibold leading-tight text-white">{getProcessingLabel(status)}</h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-white/60">
              We’re generating clips from this video now. Keep this page open if you want to watch progress, or come back when it’s done.
            </p>

            {pipelineError ? (
              <div className="mt-5 rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                <p className="font-semibold">Pipeline error</p>
                <p className="mt-1 text-red-100/80">{pipelineError}</p>
              </div>
            ) : null}

            <div className="mt-8 space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between text-sm text-white/70">
                  <span>{percent}% complete</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.max(6, Math.min(100, percent))}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
