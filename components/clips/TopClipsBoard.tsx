'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CAPTION_PRESETS } from '@/lib/caption-presets';
import { readJsonSafe } from '@/lib/safe-json';

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
  if (status === 'done') return 'Mock preview';
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

type ExpandedPlayback = {
  clipId: string;
  current: number;
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
  if (!Number.isFinite(score)) return 70;
  if (score > 10) return Math.max(70, Math.min(100, Math.round(score)));
  const normalized = Math.max(0, Math.min(10, score)) / 10;
  return Math.round(70 + normalized * 30);
}

function formatDisplayScore(score: number) {
  return String(toDisplayScore(score));
}

function getScoreColor(score: number) {
  const value = toDisplayScore(score);
  if (value >= 98) return '#22c55e';
  if (value >= 94) return '#4ade80';
  if (value >= 88) return '#a3e635';
  if (value >= 82) return '#facc15';
  if (value >= 76) return '#fb923c';
  return '#f87171';
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

function formatMockHook(title: string) {
  const words = title
    .replace(/[|:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  return words.length ? words.join(' ') : 'Top Moment';
}

function getMockCaption(title: string) {
  const words = title
    .replace(/[|:]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0]?.toUpperCase() ?? 'THIS';
  const rest = words.slice(1, 4).join(' ').toUpperCase() || 'MOMENT HITS';
  return { first, rest };
}

export function TopClipsBoard({ projectId: _projectId, clips }: Props) {
  const router = useRouter();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<Record<string, PlaybackState>>({});
  const [editingClip, setEditingClip] = useState<ClipItem | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState(CAPTION_PRESETS[0]?.id ?? 'viral-bold');
  const [selectedReframePreset, setSelectedReframePreset] = useState<'auto' | 'tight' | 'left' | 'center' | 'right'>('auto');
  const [editorTab, setEditorTab] = useState<'presets' | 'framing' | 'effects'>('presets');
  const [applyingPreset, setApplyingPreset] = useState(false);
  const [hookTextEnabled, setHookTextEnabled] = useState(true);
  const [expandedClipId, setExpandedClipId] = useState<string | null>(null);
  const [expandedPlayback, setExpandedPlayback] = useState<ExpandedPlayback | null>(null);
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

  function pauseOtherVideos(activeId: string) {
    for (const [id, video] of Object.entries(videoRefs.current)) {
      if (!video || id === activeId) continue;
      video.pause();
      updatePlayback(id, { paused: true });
    }
  }

  function handleFullscreen(id: string) {
    pauseOtherVideos(id);
    const currentVideo = videoRefs.current[id];
    const currentState = playback[id];
    const currentTime = currentVideo?.currentTime ?? currentState?.current ?? 0;
    const paused = currentVideo?.paused ?? currentState?.paused ?? true;
    const volume = currentVideo?.muted ? 0 : (currentVideo?.volume ?? currentState?.volume ?? 1);
    if (currentVideo) {
      currentVideo.pause();
      updatePlayback(id, { paused: true, current: currentTime, volume });
    }
    setExpandedPlayback({ clipId: id, current: currentTime, paused, volume });
    setExpandedClipId(id);
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
      const [presetRes, reframeRes, hookRes] = await Promise.all([
        fetch(`/api/exports/${editingClip.exportId}/caption-preset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ presetId: selectedPresetId }),
        }),
        fetch(`/api/exports/${editingClip.exportId}/reframe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preset: selectedReframePreset }),
        }),
        fetch(`/api/exports/${editingClip.exportId}/hook-text`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: hookTextEnabled }),
        }),
      ]);
      const presetData = await readJsonSafe(presetRes);
      const reframeData = await readJsonSafe(reframeRes);
      const hookData = await readJsonSafe(hookRes);
      if (!presetRes.ok) throw new Error(String(presetData?.error || 'Could not apply preset'));
      if (!reframeRes.ok) throw new Error(String(reframeData?.error || 'Could not apply reframe preset'));
      if (!hookRes.ok) throw new Error(String(hookData?.error || 'Could not update hook text'));
      setEditingClip(null);
      window.location.reload();
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not apply preset');
    } finally {
      setApplyingPreset(false);
    }
  }

  useEffect(() => {
    if (!expandedClipId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpandedClipId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expandedClipId]);

  const visible = useMemo(() => {
    return [...clips].sort((a, b) => b.score - a.score);
  }, [clips]);

  useEffect(() => {
    const hasActiveClip = visible.some((clip) => clip.status === 'queued' || clip.status === 'processing');
    if (!hasActiveClip) return;

    const timer = setInterval(() => {
      router.refresh();
    }, 4000);

    return () => clearInterval(timer);
  }, [router, visible]);

  const activePreset = CAPTION_PRESETS.find((preset) => preset.id === selectedPresetId) ?? CAPTION_PRESETS[0];

  return (
    <>
      <section className="mt-6 space-y-3">
        <h2 className="px-4 text-lg font-semibold">Top clips</h2>

        {!visible.length && <p className="px-4 text-sm text-white/60">No clips yet.</p>}

        <div className="px-4 pb-2">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
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
                <article key={clip.exportId} className="group flex min-w-0 flex-col justify-between rounded-[10px] border border-transparent px-2.5 py-2.5 transition hover:border-white/12 hover:bg-white/[0.03]">
                  <div className="min-h-[96px] px-0.5 pb-1.5">
                    <p className="line-clamp-3 min-h-[52px] text-[15px] font-extrabold leading-[1.15rem] text-white">{clip.title}</p>

                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {getClipTags(clip).map((tag) => (
                        <span key={`${clip.exportId}-${tag}`} className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-semibold text-white/80">
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="mt-1.5 flex min-h-[28px] items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[1.35rem] font-extrabold tracking-tight" style={{ color: getScoreColor(clip.score) }}>{formatDisplayScore(clip.score)}</span>
                        {toDisplayScore(clip.score) >= 90 ? (
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
                              setHookTextEnabled(true);
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
                    <div className="flex justify-center bg-transparent px-1.5">
                      <div data-clip-frame="true" className="relative aspect-[9/16] w-full max-w-[230px] overflow-hidden rounded-[8px] bg-[#15171c] ring-1 ring-white/10 transition group-hover:ring-white/22 [&:fullscreen]:mx-auto [&:fullscreen]:flex [&:fullscreen]:h-screen [&:fullscreen]:w-auto [&:fullscreen]:max-w-none [&:fullscreen]:items-center [&:fullscreen]:justify-center [&:fullscreen]:rounded-none [&:fullscreen]:bg-black [&:fullscreen]:ring-0">
                        <video
                          ref={(el) => {
                            videoRefs.current[clip.exportId] = el;
                          }}
                          preload="metadata"
                          playsInline
                          controls={false}
                          disablePictureInPicture
                          className="h-full w-full bg-black object-cover [&:fullscreen]:object-contain"
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
                          onPlay={() => {
                            pauseOtherVideos(clip.exportId);
                            updatePlayback(clip.exportId, { paused: false });
                          }}
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
                              <span className="rounded-full border border-white/15 bg-black/35 px-2.5 py-1 text-[11px] text-white/85 tabular-nums backdrop-blur-sm">
                                {currentLabel} / {totalLabel}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => void handleFullscreen(clip.exportId)}
                            className="absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white/80 backdrop-blur-sm transition hover:bg-black/50 hover:text-white"
                            aria-label="Fullscreen clip"
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                              <path d="M16 3h3a2 2 0 0 1 2 2v3" />
                              <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : clip.status === 'done' ? (
                    <div className="flex justify-center bg-transparent px-1.5">
                      <div className="relative aspect-[9/16] w-full max-w-[230px] overflow-hidden rounded-[8px] border border-white/10 bg-[linear-gradient(180deg,#4b2c1d_0%,#17101f_48%,#06070b_100%)] text-white shadow-[0_18px_55px_rgba(0,0,0,0.28)]">
                        <div className="absolute inset-x-0 top-0 h-7 bg-[linear-gradient(90deg,rgba(255,255,255,0.14)_50%,transparent_50%)] bg-[length:18px_100%] opacity-45" />
                        <div className="absolute inset-x-4 top-9 rounded-md bg-white px-3 py-2 text-center text-[13px] font-black leading-tight text-black shadow-[0_4px_18px_rgba(0,0,0,0.35)]">
                          {formatMockHook(clip.title)}
                        </div>

                        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-3 py-2 text-[9px] font-black uppercase tracking-[0.12em] text-white/70">
                          <span>Mock preview</span>
                          <span>{durationLabel ?? '0:00'}</span>
                        </div>

                        <div className="absolute inset-x-5 top-[35%] rounded-2xl border border-white/10 bg-black/20 px-3 py-5 text-center backdrop-blur-[2px]">
                          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-white/20 bg-black/35 text-lg font-black">
                            {formatDisplayScore(clip.score)}
                          </div>
                          <p className="mt-3 text-[11px] font-semibold leading-4 text-white/68">
                            Old mock placeholder. The worker will requeue this for a real FFmpeg render.
                          </p>
                        </div>

                        <div className="absolute inset-x-4 bottom-16 text-center text-xl font-black uppercase leading-[1.05] tracking-tight [text-shadow:0_3px_0_#000,0_0_12px_rgba(0,0,0,0.75)]">
                          {(() => {
                            const caption = getMockCaption(clip.title);
                            return (
                              <>
                                <span className="text-[#21f45a]">{caption.first}</span>
                                <span className="text-white"> {caption.rest}</span>
                              </>
                            );
                          })()}
                        </div>

                        <div className="absolute inset-x-4 bottom-4 h-1.5 overflow-hidden rounded-full bg-white/12">
                          <div className="h-full w-2/3 rounded-full bg-[linear-gradient(90deg,#8B7CFF,#FF7BD8,#FFB347)]" />
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

      {expandedClipId ? (() => {
        const expandedClip = clips.find((clip) => clip.exportId === expandedClipId) ?? null;
        return expandedClip ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/92 px-4 py-6" onClick={() => setExpandedClipId(null)}>
            <div className="relative flex h-full w-full items-center justify-center" onClick={(e) => e.stopPropagation()}>
              <div className="relative aspect-[9/16] h-auto max-h-[94vh] w-full max-w-[420px] overflow-hidden rounded-[18px] bg-black shadow-[0_20px_80px_rgba(0,0,0,0.55)]">
                {expandedClip.signedUrl ? (
                  <video
                    src={expandedClip.signedUrl}
                    controls
                    autoPlay={!expandedPlayback?.paused}
                    playsInline
                    preload="auto"
                    className="aspect-[9/16] h-full w-full bg-black object-cover"
                    onLoadedMetadata={(e) => {
                      if (expandedPlayback?.clipId !== expandedClip.exportId) return;
                      e.currentTarget.currentTime = expandedPlayback.current;
                      e.currentTarget.volume = expandedPlayback.volume;
                      e.currentTarget.muted = expandedPlayback.volume === 0;
                      if (!expandedPlayback.paused) {
                        void e.currentTarget.play().catch(() => null);
                      }
                    }}
                    onPlay={() => pauseOtherVideos(expandedClip.exportId)}
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center text-sm text-white/50">Preview unavailable</div>
                )}

                <button
                  type="button"
                  onClick={() => setExpandedClipId(null)}
                  className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white/90 transition hover:bg-black/75 hover:text-white"
                  aria-label="Close expanded reel"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M6 6l12 12" />
                    <path d="M18 6 6 18" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ) : null;
      })() : null}

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
                  <button
                    type="button"
                    onClick={() => setEditorTab('presets')}
                    className={`rounded-full border px-3 py-1.5 transition ${editorTab === 'presets' ? 'border-white/10 bg-white/[0.05] text-white' : 'border-white/10 hover:bg-white/[0.05]'}`}
                  >
                    Presets
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorTab('framing')}
                    className={`rounded-full border px-3 py-1.5 transition ${editorTab === 'framing' ? 'border-white/10 bg-white/[0.05] text-white' : 'border-white/10 hover:bg-white/[0.05]'}`}
                  >
                    Framing
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorTab('effects')}
                    className={`rounded-full border px-3 py-1.5 transition ${editorTab === 'effects' ? 'border-white/10 bg-white/[0.05] text-white' : 'border-white/10 hover:bg-white/[0.05]'}`}
                  >
                    Effects
                  </button>
                </div>

                {editorTab === 'presets' ? (
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
                ) : null}

                {editorTab === 'framing' ? (
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      ['auto', 'Auto'],
                      ['tight', 'Tight center'],
                      ['left', 'Left speaker'],
                      ['center', 'Center speaker'],
                      ['right', 'Right speaker'],
                    ].map(([value, label]) => {
                      const active = selectedReframePreset === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setSelectedReframePreset(value as 'auto' | 'tight' | 'left' | 'center' | 'right')}
                          className={`rounded-2xl border px-4 py-3 text-left text-sm transition ${
                            active ? 'border-white/25 bg-white/[0.08] text-white' : 'border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/[0.05]'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {editorTab === 'effects' ? (
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-white/70">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="font-semibold text-white">Auto hook text</p>
                        <p className="mt-1 text-xs text-white/55">Shows a generated top-of-screen hook for the first few seconds based on the clip title and opening transcript.</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setHookTextEnabled((prev) => !prev)}
                        className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${hookTextEnabled ? 'bg-emerald-400' : 'bg-white/15'}`}
                        aria-pressed={hookTextEnabled}
                        aria-label="Toggle auto hook text"
                      >
                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${hookTextEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-auto pt-6">
                  <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-white/70">
                    Applying <span className="font-semibold text-white">{activePreset?.name}</span> with <span className="font-semibold text-white">{selectedReframePreset}</span> framing will re-render this MP4 and save the clip changes.
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
