'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type ClipItem = {
  exportId: string;
  clipCandidateId: string | null;
  title: string;
  score: number;
  status: string;
  errorMessage: string | null;
  signedUrl: string | null;
  startSec: number | null;
  endSec: number | null;
  rank: number | null;
};
type Props = {
  projectId: string;
  clips: ClipItem[];
};

export function TopClipsBoard({ projectId, clips }: Props) {
  const router = useRouter();
  const [onlyOneMinute, setOnlyOneMinute] = useState(false);
  const [minScore, setMinScore] = useState(0);
  const [sortBy, setSortBy] = useState<'score' | 'duration'>('score');
  const [rerenderingId, setRerenderingId] = useState<string | null>(null);
  const [rerenderMsg, setRerenderMsg] = useState('');

  async function rerenderClip(clip: ClipItem) {
    if (!clip.clipCandidateId) {
      setRerenderMsg('Cannot rerender: missing candidate id.');
      return;
    }

    setRerenderingId(clip.exportId);
    setRerenderMsg('Queueing rerender...');

    try {
      const q = await fetch('/api/clips/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          candidate_ids: [clip.clipCandidateId],
          captions_enabled: true,
          caption_template: 'capcut',
        }),
      });

      if (!q.ok) {
        const qData = await q.json().catch(() => ({}));
        setRerenderMsg(`Queue failed: ${qData.error || 'unknown'}`);
        return;
      }

      const p = await fetch('/api/jobs/process', { method: 'POST' });
      const pData = await p.json();

      if (!p.ok) {
        setRerenderMsg(`Render failed: ${pData.error || 'unknown'}`);
        return;
      }

      setRerenderMsg(`Rerender done. Processed ${Number(pData.processed ?? 0)} job(s).`);
      router.refresh();
    } catch {
      setRerenderMsg('Rerender failed: network/server error.');
    } finally {
      setRerenderingId(null);
    }
  }

  const visible = useMemo(() => {
    const filtered = clips.filter((clip) => {
      const durationSec = clip.startSec != null && clip.endSec != null ? clip.endSec - clip.startSec : 0;
      const passDuration = onlyOneMinute ? durationSec >= 60 : true;
      const passScore = clip.score >= minScore;
      return passDuration && passScore;
    });

    return filtered.sort((a, b) => {
      if (sortBy === 'duration') {
        const aDur = (a.endSec ?? 0) - (a.startSec ?? 0);
        const bDur = (b.endSec ?? 0) - (b.startSec ?? 0);
        return bDur - aDur;
      }
      return b.score - a.score;
    });
  }, [clips, minScore, onlyOneMinute, sortBy]);

  return (
    <section className="mt-6 space-y-3">
      <h2 className="text-lg font-semibold">Top rendered clips (up to 10)</h2>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/20 p-3 text-xs">
        <span className="text-white/80">Captions: <span className="font-semibold text-white">Basic hardcoded ON</span></span>
        <button
          className={`rounded-md border px-3 py-1.5 transition ${onlyOneMinute ? 'border-emerald-300/40 bg-emerald-500/20 text-emerald-100' : 'border-white/15 text-white/75 hover:border-white/30'}`}
          onClick={() => setOnlyOneMinute((v) => !v)}
          type="button"
        >
          ≥ 60s
        </button>

        <label className="flex items-center gap-2 text-white/70">
          Min score
          <select
            className="rounded-md border border-white/15 bg-black/40 px-2 py-1 text-white"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
          >
            <option value={0}>Any</option>
            <option value={7}>7+</option>
            <option value={8}>8+</option>
            <option value={8.5}>8.5+</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-white/70">
          Sort
          <select
            className="rounded-md border border-white/15 bg-black/40 px-2 py-1 text-white"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'score' | 'duration')}
          >
            <option value="score">Highest score</option>
            <option value="duration">Longest duration</option>
          </select>
        </label>
      </div>

      {!visible.length && <p className="text-sm text-white/60">No clips match current filters.</p>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
        {visible.slice(0, 10).map((clip, idx) => {
          return (
            <div key={clip.exportId} className="space-y-1 rounded-lg border border-white/10 bg-black/20 p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 pr-2">
                  <p className="text-xs uppercase tracking-wide text-white/45">#{clip.rank ?? idx + 1}</p>
                  <p className="line-clamp-2 text-xs font-semibold text-white/95">{clip.title}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <span className="text-base font-extrabold tracking-tight text-lime-300 drop-shadow-[0_0_10px_rgba(132,255,121,0.75)]">
                    {clip.score.toFixed(1)}
                  </span>
                  {clip.signedUrl ? (
                    <a
                      href={clip.signedUrl}
                      download
                      className="group relative inline-flex h-7 w-7 items-center justify-center rounded-full bg-white text-black hover:bg-white/90"
                      aria-label="Download"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3v10" />
                        <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
                        <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5v-2" />
                      </svg>
                      <span className="pointer-events-none absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-black/90 px-2 py-1 text-[11px] text-white opacity-0 shadow transition-opacity group-hover:opacity-100">
                        Download
                      </span>
                    </a>
                  ) : null}
                </div>
              </div>

              {clip.signedUrl ? (
                <video
                  controls
                  preload="metadata"
                  className="aspect-[9/16] w-full overflow-hidden rounded-lg border border-white/10 bg-black"
                  src={clip.signedUrl}
                >
                  Your browser does not support the video tag.
                </video>
              ) : (
                <div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg border border-dashed border-white/15 text-white/50">
                  {clip.status === 'done' ? 'Video unavailable' : `Status: ${clip.status}`}
                </div>
              )}


              <button
                type="button"
                disabled={rerenderingId === clip.exportId || !clip.clipCandidateId}
                title={!clip.clipCandidateId ? 'Cannot rerender: this export has no clip candidate id.' : undefined}
                onClick={() => rerenderClip(clip)}
                className="w-full rounded-md border border-white/20 px-2 py-1.5 text-xs font-semibold text-white/90 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {rerenderingId === clip.exportId ? 'Rerendering…' : 'Re-render this clip'}
              </button>

              {!clip.clipCandidateId ? (
                <p className="text-[11px] text-amber-300/90">Rerender unavailable: missing candidate id on this export.</p>
              ) : null}

              {clip.errorMessage ? <p className="text-xs text-red-300/90">Error: {clip.errorMessage}</p> : null}
            </div>
          );
        })}
      </div>

      {rerenderMsg ? <p className="text-xs text-white/70">{rerenderMsg}</p> : null}
    </section>
  );
}
