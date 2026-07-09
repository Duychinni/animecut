'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { readJsonSafe } from '@/lib/safe-json';

type ProgressPayload = {
  project?: {
    id: string;
    status: string;
    pipeline_status?: string | null;
    pipeline_stage?: string | null;
    pipeline_stage_label?: string | null;
    pipeline_error?: string | null;
  };
  progress?: {
    percent: number;
    eta_seconds: number | null;
    target_exports: number;
    done_exports?: number | null;
  };
};

function getProcessingLabel(stage: string | null | undefined, fallbackStatus: string) {
  if (stage === 'downloading') return 'Preparing source video...';
  if (stage === 'extracting_audio') return 'Extracting audio...';
  if (stage === 'transcribing') return 'Transcribing audio...';
  if (stage === 'finding_hooks') return 'Finding hooks...';
  if (stage === 'creating_clips') return 'Creating top clip candidates...';
  if (stage === 'rendering') return 'Rendering clips...';
  if (stage === 'uploading_outputs') return 'Uploading final clips...';
  if (stage === 'completed') return 'Completed';

  if (fallbackStatus === 'created') return 'Preparing source video...';
  if (fallbackStatus === 'transcribed') return 'Scoring moments...';
  if (fallbackStatus === 'analyzed') return 'Rendering captions and generating thumbnails...';
  if (fallbackStatus === 'completed') return 'Completed';
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
  const completedRefreshRef = useRef(false);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/progress`, { cache: 'no-store' });
        const json = (await readJsonSafe(res)) as ProgressPayload;
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
  const pipelineStatus = String(data?.project?.pipeline_status ?? 'idle');
  const pipelineStage = data?.project?.pipeline_stage ?? null;
  const pipelineStageLabel = data?.project?.pipeline_stage_label ?? null;
  const pipelineError = data?.project?.pipeline_error ?? null;
  const isNotEnoughContent = pipelineError === 'not_enough_content';
  const isFinished = (status === 'completed' || pipelineStatus === 'completed' || percent >= 100) && !isNotEnoughContent;

  useEffect(() => {
    if (completedRefreshRef.current) return;
    if (isFinished) {
      completedRefreshRef.current = true;
      router.refresh();
    }
  }, [router, isFinished]);

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
            <h2 className="mt-4 text-3xl font-semibold leading-tight text-white">{isNotEnoughContent ? 'Not enough standalone clip material' : getProcessingLabel(pipelineStage, status)}</h2>
            <p className="mt-3 max-w-md text-sm leading-6 text-white/60">
              {isNotEnoughContent
                ? 'This upload finished analysis, but it did not contain enough complete standalone moments to turn into good reels under the current clip rules.'
                : `Current stage: ${pipelineStageLabel || getProcessingLabel(pipelineStage, status)}. Keep this page open if you want to watch progress, or come back when it’s done.`}
            </p>

            {pipelineError && !isNotEnoughContent ? (
              <div className="mt-5 rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                <p className="font-semibold">Pipeline error</p>
                <p className="mt-1 text-red-100/80">{pipelineError}</p>
              </div>
            ) : null}

            {isNotEnoughContent ? (
              <div className="mt-5 rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-50">
                <p className="font-semibold">No valid clips found</p>
                <p className="mt-1 text-amber-50/80">Try a longer source, or a segment with clearer complete thoughts, stronger hooks, and more spoken payoff.</p>
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
