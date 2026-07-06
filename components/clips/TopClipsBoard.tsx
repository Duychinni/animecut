'use client';

import { useMemo, useRef, useState } from 'react';
import { CAPTION_PRESETS } from '@/lib/caption-presets';

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

function getFriendlyStatus(status: string) {
  if (status === 'queued') return 'Queued';
  if (status === 'processing') return 'Rendering';
  if (status === 'error') return 'Render failed';
  if (status === 'done') return 'Video unavailable';
  return 'Unavailable';
}

type Props = {
  projectId: string;
  clips: ClipItem[];
};

type PlaybackState = {
  current: number;
  duration: number;
  paused: boolean;
  volume: number;
};

function formatDuration(startSec: number | null, endSec: number | null) {
  if (startSec == null || endSec == null) return null;
  const total = Math.max(0, Math.round(endSec - startSec));
  return formatClock(total);
}

function formatClock(totalSeconds: number) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function toDisplayScore(score: number) {
  const raw = Number.isFinite(score) ? score * 10 : 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function formatDisplayScore(score: number) {
  return String(toDisplayScore(score));
}

function getScoreColor(score: number) {
  const value = toDisplayScore(score);
  if (value >= 95) return '#22c55e';
  if (value >= 90) return '#4ade80';
  if (value >= 80) return '#84cc16';
  if (value >= 70) return '#facc15';
  if (value >= 60) return '#fb923c';
  return '#fb7185';
}

function getClipTags(clip: ClipItem) {
  const title = clip.title.toLowerCase();
  const tags: string[] = [];
  const score = toDisplayScore(clip.score);

  if (score >= 85) tags.push('📈 Viral');
  if (/hook|opening|start|first/i.test(clip.title)) tags.push('🔥 Hook');
  if (/funny|laugh|comedy|joke/i.test(title)) tags.push('😂 Funny');
  if (/learn|how to|educat|explain|tips/i.test(title)) tags.push('🧠 Educational');
  if (/story|journey|moment|reveal/i.test(title)) tags.push('❤️ Story');
  if (/fight|crazy|wild|intense|energy|reaction/i.test(title)) tags.push('⚡ High Energy');

  if (!tags.length && score >= 80) tags.push('🔥 Hook');
  return tags.slice(0, 3);
}

export function TopClipsBoard({ projectId: _projectId, clips }: Props) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<Record<string, PlaybackState>>({});
  const [editingClip, setEditingClip] = useState<ClipItem | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState(CAPTION_PRESETS[0]?.id ?? 'viral-bold');
  const [applyingPreset, setApplyingPreset] = useState(false);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});

  function updatePlayback(id: string, patch: Partial<PlaybackState>) {
    setPlayback((prev) => ({
      ...prev,
      [id]: {
        current: prev[id]?.current ?? 0,
        duration: prev[id]?.duration ?? 0,
        paused: prev[id]?.paused ?? true,
        volume: prev[id]?.volume ?? 1,
        ...patch,
      },
    }));
  }

  function togglePlay(id: string) {
    const video = videoRefs.current[id];
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }

  function handleSeek(id: string, value: number) {
    const video = videoRefs.current[id];
    if (!video) return;
    video.currentTime = value;
    updatePlayback(id, { current: value });
  }

  function handleVolume(id: string, value: number) {
    const video = videoRefs.current[id];
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    updatePlayback(id, { volume: value });
  }

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

  async function applyPreset() {
    if (!editingClip) return;
    try {
      setApplyingPreset(true);
      const res = await fetch(`/api/exports/${editingClip.exportId}/caption-preset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetId: selectedPresetId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not apply preset');
      setEditingClip(null);
      window.location.reload();
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not apply preset');
    } finally {
      setApplyingPreset(false);
    }
  }

  const visible = useMemo(() => {
    return [...clips].sort((a, b) => b.score - a.score);
  }, [clips]);

  const activePreset = CAPTION_PRESETS.find((preset) => preset.id === selectedPresetId) ?? CAPTION_PRESETS[0];

  return (
    <>
      <section className="mt-6 space-y-3">
        <h2 className="px-4 text-lg font-semibold">Top clips</h2>

        {!visible.length && <p className="px-4 text-sm text-white/60">No clips yet.</p>}

        <div className="px-4 pb-2">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3 xl:grid-cols-5">
            {visible.slice(0, 10).map((clip) => {
              const durationLabel = formatDuration(clip.startSec, clip.endSec);
              const playbackState = playback[clip.exportId];
              const current = playbackState?.current ?? 0;
              const duration = playbackState?.duration ?? 0;
              const totalLabel = duration > 0 ? formatClock(duration) : durationLabel ?? '0:00';
              const currentLabel = formatClock(current);
              const paused = playbackState?.paused ?? true;
              const volume = playbackState?.volume ?? 1;
              const progressPercent = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;

              return (
                <article key={clip.exportId} className="group flex min-w-0 flex-col justify-between rounded-[12px] border border-transparent px-3 py-3 transition hover:border-white/12 hover:bg-white/[0.03]">
                  <div className="min-h-[112px] px-1 pb-2">
                    <p className="line-clamp-3 min-h-[60px] text-[17px] font-extrabold leading-5 text-white">{clip.title}</p>

                    <div className="mt-2 flex flex-wrap gap-2">
                      {getClipTags(clip).map((tag) => (
                        <span key={`${clip.exportId}-${tag}`} className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-semibold text-white/80">
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="mt-2 flex min-h-[32px] items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl font-extrabold tracking-tight" style={{ color: getScoreColor(clip.score) }}>{formatDisplayScore(clip.score)}</span>
                        {toDisplayScore(clip.score) >= 85 ? (
                          <span title="Viral clip" aria-label="Viral clip" className="cursor-help text-xl leading-none">🔥</span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-5">
                        <div className="group/edit relative">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingClip(clip);
                              setSelectedPresetId(CAPTION_PRESETS[0]?.id ?? 'viral-bold');
                            }}
                            className="inline-flex items-center justify-center text-white transition hover:text-white/90"
                            aria-label="Edit clip"
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>
                          <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/edit:opacity-100">
                            Edit clip
                          </span>
                        </div>

                        {clip.signedUrl ? (
                          <div className="group/download relative">
                            <button
                              type="button"
                              onClick={() => handleDownload(clip)}
                              disabled={downloadingId === clip.exportId}
                              className="inline-flex items-center justify-center text-white transition hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-60"
                              aria-label="Download clip"
                            >
                              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M12 3v10" />
                                <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
                                <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5v-2" />
                              </svg>
                            </button>
                            <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/download:opacity-100">
                              Download clip
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {clip.signedUrl ? (
                    <div className="flex justify-center bg-transparent px-2">
                      <div className="relative aspect-[9/16] w-full max-w-[270px] overflow-hidden rounded-[8px] bg-[#15171c] ring-1 ring-white/10 transition group-hover:ring-white/22">
                        <video
                          ref={(el) => {
                            videoRefs.current[clip.exportId] = el;
                          }}
                          preload="metadata"
                          playsInline
                          controls={false}
                          disablePictureInPicture
                          className="h-full w-full bg-black object-cover"
                          src={clip.signedUrl}
                          onLoadedMetadata={(e) => {
                            const v = e.currentTarget;
                            updatePlayback(clip.exportId, {
                              current: v.currentTime || 0,
                              duration: v.duration || 0,
                              paused: v.paused,
                              volume: v.volume ?? 1,
                            });
                          }}
                          onTimeUpdate={(e) => {
                            const v = e.currentTarget;
                            updatePlayback(clip.exportId, {
                              current: v.currentTime || 0,
                              duration: v.duration || 0,
                            });
                          }}
                          onPlay={() => updatePlayback(clip.exportId, { paused: false })}
                          onPause={() => updatePlayback(clip.exportId, { paused: true })}
                          onVolumeChange={(e) => {
                            const v = e.currentTarget;
                            updatePlayback(clip.exportId, { volume: v.muted ? 0 : v.volume });
                          }}
                          onClick={() => togglePlay(clip.exportId)}
                        >
                          Your browser does not support the video tag.
                        </video>

                        {paused ? (
                          <button
                            type="button"
                            onClick={() => togglePlay(clip.exportId)}
                            className="absolute left-1/2 top-1/2 inline-flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/30 text-white backdrop-blur-sm transition hover:bg-black/45"
                            aria-label="Play clip"
                          >
                            <svg viewBox="0 0 24 24" className="h-7 w-7 fill-current" aria-hidden="true">
                              <path d="M8 5.5v13l10-6.5-10-6.5Z" />
                            </svg>
                          </button>
                        ) : null}

                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-3 pt-8">
                          <div className="relative mb-3 h-[2px] w-full bg-white/25">
                            <div className="h-full bg-white transition-[width] duration-150" style={{ width: `${progressPercent}%` }} />
                            <div
                              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white"
                              style={{ left: `calc(${progressPercent}% - 6px)` }}
                            />
                            <input
                              type="range"
                              min={0}
                              max={Math.max(duration, 0.1)}
                              step="0.01"
                              value={Math.min(current, duration || 0)}
                              onChange={(e) => handleSeek(clip.exportId, Number(e.target.value))}
                              className="absolute inset-0 h-4 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent opacity-0"
                              aria-label="Seek clip"
                            />
                          </div>

                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <svg viewBox="0 0 24 24" className="h-4 w-4 text-white/75" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                              </svg>
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step="0.01"
                                value={volume}
                                onChange={(e) => handleVolume(clip.exportId, Number(e.target.value))}
                                className="h-1.5 w-16 cursor-pointer accent-white"
                                aria-label="Clip volume"
                              />
                            </div>

                            <span className="rounded-full border border-white/15 bg-black/35 px-2.5 py-1 text-[11px] text-white/85 tabular-nums backdrop-blur-sm">
                              {currentLabel} / {totalLabel}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-center px-2">
                      <div className={`flex aspect-[9/16] w-full max-w-[270px] items-center justify-center rounded-[8px] border px-4 text-center text-sm ${clip.status === 'error' ? 'border-red-400/20 bg-red-500/[0.06] text-red-200/85' : 'border-dashed border-white/15 bg-[#121419] text-white/50'}`}>
                        {getFriendlyStatus(clip.status)}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {editingClip ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-sm">
          <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-white/10 bg-[#0d0f14] shadow-[0_0_60px_rgba(0,0,0,0.5)]">
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/40">Edit Clip</p>
                <h3 className="mt-1 text-lg font-semibold text-white">{editingClip.title}</h3>
              </div>
              <button type="button" onClick={() => setEditingClip(null)} className="text-sm text-white/65 transition hover:text-white">
                Close
              </button>
            </div>

            <div className="grid flex-1 gap-0 lg:grid-cols-[0.95fr_1.05fr]">
              <div className="border-b border-white/10 p-6 lg:border-b-0 lg:border-r">
                <div className="overflow-hidden rounded-[18px] border border-white/10 bg-black">
                  {editingClip.signedUrl ? (
                    <video src={editingClip.signedUrl} controls className="aspect-[9/16] w-full object-cover bg-black" />
                  ) : (
                    <div className="grid aspect-[9/16] place-items-center text-sm text-white/45">Preview unavailable</div>
                  )}
                </div>
              </div>

              <div className="flex flex-col p-6">
                <div className="mb-5 flex gap-2 text-xs font-semibold text-white/60">
                  <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-white">Presets</span>
                  <span className="rounded-full border border-white/10 px-3 py-1.5">Font</span>
                  <span className="rounded-full border border-white/10 px-3 py-1.5">Effects</span>
                </div>

                <div className="grid gap-3">
                  {CAPTION_PRESETS.map((preset) => {
                    const active = preset.id === selectedPresetId;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setSelectedPresetId(preset.id)}
                        className={`rounded-2xl border px-4 py-4 text-left transition ${
                          active ? 'border-white/25 bg-white/[0.08]' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-white">{preset.name}</p>
                            <p className="mt-1 text-xs text-white/60">{preset.captionFontFamily}</p>
                          </div>
                          <div className="flex gap-2">
                            <span className="h-4 w-4 rounded-full border border-white/15" style={{ backgroundColor: preset.captionTextColor }} />
                            <span className="h-4 w-4 rounded-full border border-white/15" style={{ backgroundColor: preset.captionHighlightColor }} />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-auto pt-6">
                  <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-white/70">
                    Applying <span className="font-semibold text-white">{activePreset?.name}</span> will re-render this MP4 with burned-in captions and save the preset to this clip.
                  </div>
                  <button
                    type="button"
                    onClick={() => void applyPreset()}
                    disabled={applyingPreset}
                    className="w-full rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {applyingPreset ? 'Applying...' : 'Apply'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
