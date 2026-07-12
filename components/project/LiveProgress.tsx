'use client';

import { useEffect, useState } from 'react';

const STAGE_CEILINGS: Record<string, number> = {
  queued: 7.8,
  downloading: 13.8,
  extracting_audio: 23.8,
  transcribing: 43.8,
  finding_hooks: 59.8,
  creating_clips: 69.8,
  face_tracking_crop: 77.8,
  rendering: 95.8,
  uploading_outputs: 98,
};

const STAGE_RATES: Record<string, number> = {
  queued: 0.12,
  downloading: 0.12,
  extracting_audio: 0.14,
  transcribing: 0.08,
  finding_hooks: 0.1,
  creating_clips: 0.16,
  face_tracking_crop: 0.12,
  rendering: 0.1,
  uploading_outputs: 0.05,
};

function normalizePercent(value: number) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function formatLivePercent(value: number) {
  const normalized = normalizePercent(value);
  return normalized >= 100 ? '100' : normalized.toFixed(1);
}

export function useLiveProgress(rawPercent: number, active: boolean, stage?: string | null) {
  const normalized = normalizePercent(rawPercent);
  const [displayPercent, setDisplayPercent] = useState(normalized);

  useEffect(() => {
    setDisplayPercent((current) => normalized >= 100 ? 100 : Math.max(current, normalized));
  }, [normalized]);

  useEffect(() => {
    if (!active || normalized >= 100) {
      setDisplayPercent(normalized);
      return;
    }

    const stageKey = stage ?? '';
    const ceiling = Math.min(98, STAGE_CEILINGS[stageKey] ?? Math.max(normalized + 4, 8));
    const ratePerSecond = STAGE_RATES[stageKey] ?? 0.07;
    const intervalMs = 500;
    const timer = window.setInterval(() => {
      setDisplayPercent((current) => {
        const floor = Math.max(current, normalized);
        if (floor >= ceiling) return floor;
        return Math.min(ceiling, floor + ratePerSecond * (intervalMs / 1000));
      });
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [active, normalized, stage]);

  return normalizePercent(displayPercent);
}

function ClockIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 4.6v3.7l2.6 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LiveProgressPill({
  percent,
  active,
  stage,
  stageLabel,
  etaLabel,
}: {
  percent: number;
  active: boolean;
  stage?: string | null;
  stageLabel: string;
  etaLabel?: string | null;
}) {
  const livePercent = useLiveProgress(percent, active, stage);

  return (
    <div className="relative isolate flex min-w-[164px] flex-col items-center justify-center gap-0.5 overflow-hidden rounded-full border border-emerald-300/25 bg-black/76 px-3 py-2 text-center text-emerald-100 shadow-[0_10px_28px_rgba(0,0,0,0.32)] backdrop-blur-sm">
      <div
        className="absolute inset-y-0 left-0 -z-10 overflow-hidden bg-emerald-400/35 shadow-[0_0_18px_rgba(52,211,153,0.55)] transition-[width] duration-500 ease-linear"
        style={{ width: `${Math.max(6, livePercent)}%` }}
      >
        {active ? <span className="progress-active-sheen absolute inset-y-0 block w-12 bg-gradient-to-r from-transparent via-white/30 to-transparent" /> : null}
      </div>
      <span className="inline-flex items-center gap-1.5 text-[12px] font-extrabold leading-none tabular-nums">
        <ClockIcon className="h-3.5 w-3.5" />
        {formatLivePercent(livePercent)}%
        {etaLabel ? <span className="font-black text-emerald-50/85">({etaLabel})</span> : null}
      </span>
      <span className="max-w-[142px] truncate text-[9px] font-black uppercase tracking-[0.08em] text-emerald-50/85">{stageLabel}</span>
    </div>
  );
}
