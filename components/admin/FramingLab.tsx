'use client';

import { useEffect, useMemo, useState } from 'react';

type LabResult = {
  originalUrl: string;
  previewUrl: string;
  debugUrl: string | null;
  fileName: string;
  metrics: {
    duration: number;
    trackCount: number;
    speakerSwitches: number;
    detectionRate: number;
    fallbackCount: number;
    timelineSegments: number;
    layoutModes: string[];
  };
  decisions: Array<{
    start: number;
    end: number;
    mode: string;
    reason: string;
    activeTrackId: number | null;
    confidence: number;
  }>;
};

function download(url: string, fileName: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function FramingLab() {
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LabResult | null>(null);
  const localUrl = useMemo(() => file ? URL.createObjectURL(file) : '', [file]);

  useEffect(() => () => {
    if (localUrl) URL.revokeObjectURL(localUrl);
  }, [localUrl]);

  async function analyze() {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const body = new FormData();
      body.set('file', file);
      body.set('duration', String(duration));
      const response = await fetch('/api/admin/framing-lab/analyze', { method: 'POST', body });
      const payload = await response.json() as LabResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Framing analysis failed');
      setResult(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Framing analysis failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-[1500px] px-4 py-8 sm:px-6">
      <div className="rounded-3xl border border-white/10 bg-black/35 p-6 shadow-2xl backdrop-blur">
        <p className="text-xs font-black uppercase tracking-[0.28em] text-[#ff7bd8]">Admin experiment</p>
        <h1 className="mt-3 text-3xl font-black sm:text-4xl">Speaker Framing Lab</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-white/65">
          Test AnimaCut&apos;s real speaker tracker without changing normal user renders. Use a short horizontal
          podcast section with two visible speakers for the clearest comparison.
        </p>

        <div className="mt-6 grid gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 md:grid-cols-[1fr_auto_auto] md:items-end">
          <label className="block text-sm font-bold">
            Test video
            <input
              className="mt-2 block w-full rounded-xl border border-white/15 bg-black/30 px-3 py-3 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:font-bold file:text-black"
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
          <label className="text-sm font-bold">
            Analyze
            <select
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              className="mt-2 block rounded-xl border border-white/15 bg-black px-4 py-3"
            >
              <option value={10}>First 10 sec</option>
              <option value={20}>First 20 sec</option>
              <option value={30}>First 30 sec</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!file || busy}
            onClick={analyze}
            className="rounded-xl bg-white px-5 py-3 text-sm font-black text-black transition hover:bg-[#ff7bd8] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? 'Tracking speakers…' : 'Analyze framing'}
          </button>
        </div>

        {error ? <p className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">{error}</p> : null}

        {localUrl || result ? (
          <section className="mt-8 grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-3 text-sm font-black uppercase tracking-wider text-white/60">Original</h2>
              <video className="aspect-video w-full rounded-2xl bg-black object-contain" src={result?.originalUrl || localUrl} controls />
            </div>
            <div>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-black uppercase tracking-wider text-white/60">Proposed 9:16 crop</h2>
                {result ? (
                  <button className="text-sm font-bold text-[#ff7bd8] hover:text-white" onClick={() => download(result.previewUrl, result.fileName)}>
                    Download preview
                  </button>
                ) : null}
              </div>
              <div className="flex min-h-80 items-center justify-center rounded-2xl bg-black/50">
                {result ? <video className="aspect-[9/16] max-h-[680px] rounded-xl bg-black" src={result.previewUrl} controls /> : <span className="text-sm text-white/40">Analyze to create preview</span>}
              </div>
            </div>
          </section>
        ) : null}

        {result ? (
          <>
            <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ['Face tracks', result.metrics.trackCount],
                ['Speaker cuts', result.metrics.speakerSwitches],
                ['Detection', `${Math.round(result.metrics.detectionRate * 100)}%`],
                ['Fallbacks', result.metrics.fallbackCount],
                ['Segments', result.metrics.timelineSegments],
                ['Modes', result.metrics.layoutModes.join(', ') || 'single'],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-white/45">{label}</p>
                  <p className="mt-2 break-words text-xl font-black">{value}</p>
                </div>
              ))}
            </section>

            {result.debugUrl ? (
              <section className="mt-8">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-black">Debug overlay</h2>
                    <p className="text-sm text-white/55">Face IDs, active speaker, crop boundary, movement path, and layout decisions.</p>
                  </div>
                  <button className="text-sm font-bold text-[#ff7bd8] hover:text-white" onClick={() => download(result.debugUrl!, 'framing-debug.mp4')}>Download debug</button>
                </div>
                <video className="w-full rounded-2xl bg-black" src={result.debugUrl} controls />
              </section>
            ) : null}

            <section className="mt-8">
              <h2 className="text-lg font-black">Decision timeline</h2>
              <div className="mt-3 overflow-hidden rounded-2xl border border-white/10">
                {result.decisions.map((item, index) => (
                  <div key={`${item.start}-${index}`} className="grid gap-2 border-b border-white/10 px-4 py-3 text-sm last:border-0 md:grid-cols-[110px_130px_1fr_110px]">
                    <span className="font-mono text-white/60">{item.start.toFixed(1)}–{item.end.toFixed(1)}s</span>
                    <span className="font-bold">{item.mode}</span>
                    <span className="text-white/65">{item.reason}</span>
                    <span className="text-white/55">ID {item.activeTrackId ?? '—'} · {Math.round(item.confidence * 100)}%</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
