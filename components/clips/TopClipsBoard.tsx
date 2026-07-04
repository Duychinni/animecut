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
    return [...clips].sort((a, b) => b.score - a.score);
  }, [clips]);

  return (
    <section className="mt-6 space-y-3">
      <h2 className="text-lg font-semibold">Top clips</h2>

      {!visible.length && <p className="text-sm text-white/60">No clips yet.</p>}

      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max gap-7">
          {visible.slice(0, 10).map((clip, idx) => {
            const durationLabel = formatDuration(clip.startSec, clip.endSec);

            return (
              <article key={clip.exportId} className="w-[210px] shrink-0">
                {clip.signedUrl ? (
                  <div className="relative overflow-hidden rounded-[18px] bg-[#15171c] ring-1 ring-white/10">
                    <video
                      controls
                      preload="metadata"
                      className="aspect-[9/16] w-full bg-black object-cover"
                      src={clip.signedUrl}
                    >
                      Your browser does not support the video tag.
                    </video>

                    {durationLabel ? (
                      <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/80 px-1.5 py-1 text-[10px] font-medium text-white">
                        {durationLabel}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex aspect-[9/16] w-full items-center justify-center rounded-[18px] border border-dashed border-white/15 bg-[#121419] px-4 text-center text-white/50">
                    {clip.status === 'done' ? 'Video unavailable' : `Status: ${clip.status}`}
                  </div>
                )}

                <div className="mt-2 space-y-1">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-white/30">Clip {clip.rank ?? idx + 1}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-lg font-extrabold tracking-tight text-lime-300">{Math.round(clip.score * 10)}</span>
                    {clip.signedUrl ? (
                      <button
                        type="button"
                        onClick={() => handleDownload(clip)}
                        disabled={downloadingId === clip.exportId}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/15 text-white/75 transition hover:border-white/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                        aria-label="Download clip"
                        title="Download clip"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 3v10" />
                          <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
                          <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5v-2" />
                        </svg>
                      </button>
                    ) : null}
                  </div>
                  <p className="line-clamp-3 text-[13px] font-medium leading-4 text-white/90">{clip.title}</p>
                </div>

                {clip.errorMessage ? <p className="mt-1 text-xs text-red-300/90 line-clamp-2">Error: {clip.errorMessage}</p> : null}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
