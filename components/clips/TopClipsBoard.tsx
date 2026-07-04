'use client';

import { useMemo, useState } from 'react';

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

function formatDuration(startSec: number | null, endSec: number | null) {
  if (startSec == null || endSec == null) return null;
  const total = Math.max(0, Math.round(endSec - startSec));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function TopClipsBoard({ projectId: _projectId, clips }: Props) {
  const [onlyOneMinute, setOnlyOneMinute] = useState(false);
  const [minScore, setMinScore] = useState(0);
  const [sortBy, setSortBy] = useState<'score' | 'duration'>('score');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function handleDownload(clip: ClipItem) {
    if (!clip.signedUrl) return;

    try {
      setDownloadingId(clip.exportId);
      const res = await fetch(clip.signedUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `${(clip.title || 'clip')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'clip'}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.error(error);
      window.alert('Download failed. Try again.');
    } finally {
      setDownloadingId(null);
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
    <section className="mt-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Top clips</h2>
      </div>

      {!visible.length && <p className="text-sm text-white/60">No clips yet.</p>}

      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max gap-4">
          {visible.slice(0, 10).map((clip, idx) => {
            const durationLabel = formatDuration(clip.startSec, clip.endSec);

            return (
              <article key={clip.exportId} className="w-[220px] shrink-0 space-y-3">
                {clip.signedUrl ? (
                  <div className="relative overflow-hidden rounded-[22px] bg-[#16181d] ring-1 ring-white/10">
                    <video
                      controls
                      preload="metadata"
                      className="aspect-[9/16] w-full bg-black object-cover"
                      src={clip.signedUrl}
                    >
                      Your browser does not support the video tag.
                    </video>

                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                    {durationLabel ? (
                      <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
                        {durationLabel}
                      </div>
                    ) : null}

                    <div className="pointer-events-none absolute bottom-3 left-3 rounded-full bg-black/70 px-2.5 py-1 text-[12px] font-semibold text-white backdrop-blur-sm">
                      {clip.score.toFixed(1)}/10
                    </div>

                  </div>
                ) : (
                  <div className="flex aspect-[9/16] w-full items-center justify-center rounded-[22px] border border-dashed border-white/15 bg-[#121419] px-4 text-center text-white/50">
                    {clip.status === 'done' ? 'Video unavailable' : `Status: ${clip.status}`}
                  </div>
                )}

                <div className="space-y-2 px-1">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Clip {clip.rank ?? idx + 1}</p>
                  <p className="line-clamp-2 text-sm font-semibold text-white/95">{clip.title}</p>

                  {clip.signedUrl ? (
                    <button
                      type="button"
                      onClick={() => handleDownload(clip)}
                      disabled={downloadingId === clip.exportId}
                      className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-white transition hover:border-white/30 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3v10" />
                        <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
                        <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5v-2" />
                      </svg>
                      {downloadingId === clip.exportId ? 'Downloading…' : 'Download'}
                    </button>
                  ) : null}
                </div>

                {clip.errorMessage ? <p className="px-1 text-xs text-red-300/90 line-clamp-3">Error: {clip.errorMessage}</p> : null}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
