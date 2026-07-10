'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { CaptionPreset } from '@/lib/caption-presets';
import type { ClipEditSettings, TranscriptPhrase, TranscriptSegment } from '@/lib/clip-edit';

type EditorData = {
  project: {
    id: string;
    title: string;
    sourceType: string;
    sourceDurationSeconds: number;
  };
  clip: {
    id: string;
    projectId: string;
    candidateId: string | null;
    title: string;
    aiStartSeconds: number;
    aiEndSeconds: number;
    score: number;
    reason: string | null;
    status: string;
    editStatus: string;
    errorMessage: string | null;
    signedUrl: string | null;
    posterUrl: string | null;
    updatedAt: string | null;
  };
  source: {
    previewUrl: string | null;
    fallbackClipUrl: string | null;
    posterUrl: string | null;
    durationSeconds: number;
  };
  transcript: {
    segments: TranscriptSegment[];
    phrases: TranscriptPhrase[];
  };
  settings: ClipEditSettings;
  presets: CaptionPreset[];
};

type Tab = 'clip' | 'transcript' | 'captions' | 'framing';
type DragMode = 'start' | 'end' | 'seek' | null;

const PRESET_IDS = ['viral-bold', 'opus-clean', 'creator-glow', 'podcast-pro', 'minimal-pro'];

function formatClock(totalSeconds: number) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatPrecise(seconds: number) {
  return Math.max(0, seconds).toFixed(2);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function cleanWords(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 4)
    .map((word) => word.replace(/[^\w'?!-]/g, '').toUpperCase())
    .filter(Boolean);
}

function safeJson(value: unknown) {
  return JSON.stringify(value);
}

function captionPreviewStyle(preset: CaptionPreset | undefined, settings: ClipEditSettings) {
  const textColor = settings.caption_text_color || preset?.captionTextColor || '#ffffff';
  const strokeColor = preset?.captionStrokeColor || '#000000';
  const fontFamily = preset?.captionFontFamily || 'Arial Black';
  const fontSize = settings.caption_font_size * 3.3;
  return {
    color: textColor,
    fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: 950,
    letterSpacing: 0,
    lineHeight: 1.02,
    textTransform: 'uppercase' as const,
    WebkitTextStroke: settings.caption_background ? '0 transparent' : `${Math.max(1, Math.round(fontSize * 0.08))}px ${strokeColor}`,
    textShadow: settings.caption_background
      ? 'none'
      : `0 3px 0 #000, 0 8px 18px rgba(0,0,0,.78)`,
  };
}

function positionClass(position: ClipEditSettings['caption_position']) {
  if (position === 'upper') return 'top-[18%]';
  if (position === 'center') return 'top-1/2 -translate-y-1/2';
  return 'bottom-[15%]';
}

export function ClipEditor({ projectId, clipId }: { projectId: string; clipId: string }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<EditorData | null>(null);
  const [settings, setSettings] = useState<ClipEditSettings | null>(null);
  const [baseline, setBaseline] = useState('');
  const [tab, setTab] = useState<Tab>('clip');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(1);
  const [dragMode, setDragMode] = useState<DragMode>(null);

  const hasSourcePreview = Boolean(data?.source.previewUrl);
  const previewUrl = data?.source.previewUrl || data?.source.fallbackClipUrl || null;
  const sourceDuration = data?.source.durationSeconds ?? settings?.clip_end_seconds ?? 90;
  const changed = Boolean(settings && baseline && safeJson(settings) !== baseline);
  const needsRender = changed || data?.clip.editStatus === 'draft' || data?.clip.editStatus === 'error';

  const activePreset = useMemo(() => {
    if (!data || !settings) return undefined;
    return data.presets.find((preset) => preset.id === settings.caption_preset_id) ?? data.presets[0];
  }, [data, settings]);

  const presetOptions = useMemo(() => {
    if (!data) return [];
    const picked = PRESET_IDS.map((id) => data.presets.find((preset) => preset.id === id)).filter((preset): preset is CaptionPreset => Boolean(preset));
    return picked.length ? picked : data.presets.slice(0, 5);
  }, [data]);

  const selectedPhrases = useMemo(() => {
    if (!settings) return [];
    return settings.edited_transcript.filter((phrase) => phrase.end >= settings.clip_start_seconds - 15 && phrase.start <= settings.clip_end_seconds + 15);
  }, [settings]);

  const currentPhrase = useMemo(() => {
    if (!settings) return null;
    return settings.edited_transcript.find((phrase) => !phrase.deleted && currentTime >= phrase.start && currentTime <= phrase.end) ?? null;
  }, [currentTime, settings]);

  const previewWords = useMemo(() => {
    const words = cleanWords(currentPhrase?.text || data?.clip.title || 'THIS CLIP');
    return words.length ? words : ['THIS', 'CLIP'];
  }, [currentPhrase, data?.clip.title]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clips/${clipId}/edit`, { cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(String(json?.error || 'Could not load clip editor'));
    setData(json);
    setSettings(json.settings);
    setBaseline(safeJson(json.settings));
    setCurrentTime(Number(json.settings.clip_start_seconds ?? 0));
    setRendering(json.clip?.editStatus === 'rendering');
  }, [clipId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load()
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Could not load clip editor');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  useEffect(() => {
    if (!changed) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [changed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      handleBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    if (!rendering) return;
    const timer = window.setInterval(async () => {
      try {
        await fetch('/api/jobs/process', { method: 'POST', cache: 'no-store' }).catch(() => null);
        const res = await fetch(`/api/clips/${clipId}/edit`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) return;
        setData(json);
        setSettings(json.settings);
        if (json.clip?.editStatus === 'rendered' || json.clip?.editStatus === 'idle') {
          setRendering(false);
          setBaseline(safeJson(json.settings));
          setToast('Updated clip ready');
          router.refresh();
          window.setTimeout(() => {
            router.push(`/dashboard/projects/${projectId}`);
          }, 700);
        }
        if (json.clip?.editStatus === 'error') {
          setRendering(false);
          setError(json.clip?.errorMessage || 'Clip update failed');
        }
      } catch {
        // Keep polling. The worker may still be finishing.
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [clipId, projectId, rendering, router]);

  useEffect(() => {
    if (!settings || !videoRef.current) return;
    const video = videoRef.current;
    const target = hasSourcePreview ? settings.clip_start_seconds : 0;
    if (Math.abs(video.currentTime - target) > 0.5) {
      video.currentTime = target;
    }
  }, [hasSourcePreview, settings?.clip_start_seconds]);

  function patchSettings(patch: Partial<ClipEditSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function patchTimes(start: number, end: number) {
    if (!settings) return;
    const maxEnd = Math.max(10, sourceDuration);
    const safeStart = clamp(start, 0, Math.max(0, maxEnd - 10));
    const safeEnd = clamp(end, safeStart + 10, Math.min(maxEnd, safeStart + 90));
    patchSettings({ clip_start_seconds: safeStart, clip_end_seconds: safeEnd });
  }

  function updatePhrase(id: string, patch: Partial<TranscriptPhrase>) {
    if (!settings) return;
    patchSettings({
      edited_transcript: settings.edited_transcript.map((phrase) => phrase.id === id ? { ...phrase, ...patch } : phrase),
    });
  }

  function restoreTranscript() {
    if (!data || !settings) return;
    patchSettings({
      edited_transcript: data.transcript.phrases.map((phrase) => ({ ...phrase, text: phrase.originalText, deleted: false })),
    });
  }

  function seekAbsolute(seconds: number) {
    const video = videoRef.current;
    const safe = clamp(seconds, 0, sourceDuration);
    setCurrentTime(safe);
    if (!video) return;
    video.currentTime = hasSourcePreview ? safe : Math.max(0, safe - (settings?.clip_start_seconds ?? 0));
  }

  async function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      setPaused(true);
      return;
    }
    try {
      await video.play();
      setPaused(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? '');
      if (!/play\(\) request was interrupted|AbortError/i.test(message)) {
        setError('Preview could not start. Try again.');
      }
    }
  }

  async function saveDraft(showToast = true) {
    if (!settings) return null;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/edit`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || 'Could not save'));
      setData(json);
      setSettings(json.settings);
      setBaseline(safeJson(json.settings));
      if (showToast) setToast('Draft saved');
      return json as EditorData;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function rerenderClip() {
    if (!settings) return;
    setRendering(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/rerender`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || 'Could not start render'));
      setData(json);
      setSettings(json.settings);
      setBaseline(safeJson(json.settings));
      await fetch('/api/jobs/process', { method: 'POST', cache: 'no-store' }).catch(() => null);
      setToast('Rendering updated clip');
    } catch (err) {
      setRendering(false);
      setError(err instanceof Error ? err.message : 'Could not start render');
    }
  }

  function handleBack() {
    if (changed && !window.confirm('Leave without saving your clip edits?')) return;
    router.push(`/dashboard/projects/${projectId}`);
  }

  function timelineSeconds(event: PointerEvent | ReactPointerEvent<HTMLElement>) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    return (x / rect.width) * sourceDuration;
  }

  function beginTimelineDrag(mode: DragMode, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    setDragMode(mode);
    const seconds = timelineSeconds(event);
    if (mode === 'start' && settings) patchTimes(seconds, settings.clip_end_seconds);
    if (mode === 'end' && settings) patchTimes(settings.clip_start_seconds, seconds);
    if (mode === 'seek') seekAbsolute(seconds);
  }

  useEffect(() => {
    if (!dragMode) return;
    const onMove = (event: PointerEvent) => {
      if (!settings) return;
      const seconds = timelineSeconds(event);
      if (dragMode === 'start') patchTimes(seconds, settings.clip_end_seconds);
      if (dragMode === 'end') patchTimes(settings.clip_start_seconds, seconds);
      if (dragMode === 'seek') seekAbsolute(seconds);
    };
    const onUp = () => setDragMode(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragMode, settings, sourceDuration]);

  if (loading) {
    return (
      <main className="mx-auto grid min-h-[calc(100vh-92px)] w-full max-w-7xl place-items-center px-6 py-10 text-white">
        <div className="w-full max-w-4xl animate-pulse rounded-[20px] border border-white/10 bg-white/[0.03] p-8">
          <div className="h-6 w-64 rounded bg-white/10" />
          <div className="mt-8 grid gap-6 lg:grid-cols-[0.85fr_1fr]">
            <div className="aspect-[9/16] rounded-[18px] bg-white/10" />
            <div className="space-y-4">
              <div className="h-12 rounded bg-white/10" />
              <div className="h-28 rounded bg-white/10" />
              <div className="h-40 rounded bg-white/10" />
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!data || !settings) {
    return (
      <main className="mx-auto grid min-h-[calc(100vh-92px)] w-full max-w-4xl place-items-center px-6 py-10 text-white">
        <div className="rounded-[18px] border border-red-400/20 bg-red-500/[0.07] p-8 text-center">
          <h1 className="text-xl font-bold">Clip editor unavailable</h1>
          <p className="mt-2 text-sm text-red-100/75">{error || 'Could not load this clip.'}</p>
          <button onClick={() => router.push(`/dashboard/projects/${projectId}`)} className="mt-6 rounded-full bg-white px-5 py-2 text-sm font-bold text-black">
            Back to project
          </button>
        </div>
      </main>
    );
  }

  const clipDuration = Math.max(0, settings.clip_end_seconds - settings.clip_start_seconds);
  const selectedLeft = `${(settings.clip_start_seconds / sourceDuration) * 100}%`;
  const selectedWidth = `${(clipDuration / sourceDuration) * 100}%`;
  const playheadLeft = `${(currentTime / sourceDuration) * 100}%`;
  const captionStyle = captionPreviewStyle(activePreset, settings);

  return (
    <main className="mx-auto w-full max-w-[1800px] px-6 py-7 text-white">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-white/42">Clip Editor</p>
          <h1 className="mt-1 max-w-4xl text-xl font-black leading-tight text-white">{data.clip.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {toast ? <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-200">{toast}</span> : null}
          <button onClick={handleBack} className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-white/75 transition hover:bg-white/[0.06] hover:text-white">
            Back to project
          </button>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-2xl border border-red-400/25 bg-red-500/[0.08] px-4 py-3 text-sm font-semibold text-red-100">
          {error}
        </div>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-[minmax(360px,560px)_minmax(520px,1fr)]">
        <div className="space-y-4">
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[520px] overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[0_24px_90px_rgba(0,0,0,.45)]">
            {previewUrl ? (
              <video
                ref={videoRef}
                src={previewUrl}
                poster={data.clip.posterUrl ?? undefined}
                playsInline
                preload="auto"
                className="h-full w-full bg-black object-cover"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  video.volume = volume;
                  video.currentTime = hasSourcePreview ? settings.clip_start_seconds : 0;
                }}
                onTimeUpdate={(event) => {
                  const video = event.currentTarget;
                  const absolute = hasSourcePreview ? video.currentTime : settings.clip_start_seconds + video.currentTime;
                  setCurrentTime(absolute);
                  if (hasSourcePreview && absolute >= settings.clip_end_seconds) {
                    video.pause();
                    setPaused(true);
                  }
                }}
                onPlay={() => setPaused(false)}
                onPause={() => setPaused(true)}
                onVolumeChange={(event) => setVolume(event.currentTarget.muted ? 0 : event.currentTarget.volume)}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-white/45">Preview unavailable</div>
            )}

            {settings.captions_enabled ? (
              <div className={`pointer-events-none absolute inset-x-5 ${positionClass(settings.caption_position)} flex justify-center text-center`}>
                {settings.caption_background ? (
                  <span className="rounded-lg bg-white px-4 py-2 shadow-[0_8px_26px_rgba(0,0,0,.35)]" style={{ ...captionStyle, color: '#101114', WebkitTextStroke: '0 transparent' }}>
                    {previewWords.join(' ')}
                  </span>
                ) : (
                  <span style={captionStyle}>
                    <span style={{ color: settings.caption_word_highlight ? settings.caption_highlight_color : settings.caption_text_color }}>{previewWords[0]}</span>
                    {previewWords.length > 1 ? <span> {previewWords.slice(1).join(' ')}</span> : null}
                  </span>
                )}
              </div>
            ) : null}

            {rendering ? (
              <div className="absolute inset-x-5 top-5 rounded-2xl border border-emerald-300/20 bg-black/62 px-4 py-3 text-center text-xs font-bold uppercase tracking-[0.14em] text-emerald-200 backdrop-blur">
                Rendering updated clip
              </div>
            ) : null}
          </div>

          <div className="mx-auto flex max-w-[520px] flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <button onClick={() => void togglePlay()} className="rounded-full bg-white px-4 py-2 text-sm font-black text-black transition hover:bg-white/90">
              {paused ? 'Play' : 'Pause'}
            </button>
            <span className="text-sm font-semibold text-white/70 tabular-nums">{formatClock(Math.max(0, currentTime - settings.clip_start_seconds))} / {formatClock(clipDuration)}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  video.muted = !video.muted;
                }}
                className="rounded-full border border-white/10 px-3 py-2 text-xs font-bold text-white/75 hover:bg-white/[0.06]"
              >
                {volume === 0 ? 'Muted' : 'Mute'}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => {
                  const v = Number(event.target.value);
                  const video = videoRef.current;
                  setVolume(v);
                  if (video) {
                    video.volume = v;
                    video.muted = v === 0;
                  }
                }}
                className="w-24 accent-white"
                aria-label="Volume"
              />
              <button
                onClick={() => videoRef.current?.requestFullscreen?.()}
                className="rounded-full border border-white/10 px-3 py-2 text-xs font-bold text-white/75 hover:bg-white/[0.06]"
              >
                Fullscreen
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-[18px] border border-white/10 bg-[#0e1117]/95 shadow-[0_24px_90px_rgba(0,0,0,.35)]">
          <div className="flex flex-wrap gap-2 border-b border-white/10 px-4 py-3">
            {(['clip', 'transcript', 'captions', 'framing'] as Tab[]).map((item) => (
              <button
                key={item}
                onClick={() => setTab(item)}
                className={`rounded-full px-4 py-2 text-sm font-bold capitalize transition ${tab === item ? 'bg-white text-black' : 'border border-white/10 text-white/70 hover:bg-white/[0.06] hover:text-white'}`}
              >
                {item}
              </button>
            ))}
          </div>

          <div className="min-h-[560px] p-5">
            {tab === 'clip' ? (
              <div className="space-y-5">
                <div className="grid gap-4 md:grid-cols-3">
                  <label className="space-y-1 text-sm font-semibold text-white/65">
                    Start time
                    <input
                      type="number"
                      step="0.1"
                      value={formatPrecise(settings.clip_start_seconds)}
                      onChange={(event) => patchTimes(Number(event.target.value), settings.clip_end_seconds)}
                      className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-white outline-none focus:border-white/30"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-semibold text-white/65">
                    End time
                    <input
                      type="number"
                      step="0.1"
                      value={formatPrecise(settings.clip_end_seconds)}
                      onChange={(event) => patchTimes(settings.clip_start_seconds, Number(event.target.value))}
                      className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-white outline-none focus:border-white/30"
                    />
                  </label>
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
                    <p className="text-sm font-semibold text-white/55">Duration</p>
                    <p className="mt-1 text-2xl font-black text-white">{formatClock(clipDuration)}</p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <button onClick={() => patchTimes(data.clip.aiStartSeconds, data.clip.aiEndSeconds)} className="rounded-xl border border-white/10 px-4 py-3 text-left text-sm font-bold text-white/80 hover:bg-white/[0.06]">
                    Reset to AI selection
                  </button>
                  <button onClick={() => patchTimes(settings.clip_start_seconds - 5, settings.clip_end_seconds)} className="rounded-xl border border-white/10 px-4 py-3 text-left text-sm font-bold text-white/80 hover:bg-white/[0.06]">
                    Add 5 seconds before
                  </button>
                  <button onClick={() => patchTimes(settings.clip_start_seconds, settings.clip_end_seconds + 5)} className="rounded-xl border border-white/10 px-4 py-3 text-left text-sm font-bold text-white/80 hover:bg-white/[0.06]">
                    Add 5 seconds after
                  </button>
                  <button onClick={() => patchTimes(settings.clip_start_seconds + 5, settings.clip_end_seconds)} className="rounded-xl border border-white/10 px-4 py-3 text-left text-sm font-bold text-white/80 hover:bg-white/[0.06]">
                    Remove 5 seconds from start
                  </button>
                  <button onClick={() => patchTimes(settings.clip_start_seconds, settings.clip_end_seconds - 5)} className="rounded-xl border border-white/10 px-4 py-3 text-left text-sm font-bold text-white/80 hover:bg-white/[0.06]">
                    Remove 5 seconds from end
                  </button>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-sm font-black text-white">Nearby transcript context</p>
                  <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                    {selectedPhrases.map((phrase) => (
                      <button
                        key={phrase.id}
                        onClick={() => seekAbsolute(phrase.start)}
                        className={`block w-full rounded-xl px-3 py-2 text-left text-sm transition ${phrase.start >= settings.clip_start_seconds && phrase.end <= settings.clip_end_seconds ? 'bg-emerald-400/[0.08] text-white' : 'bg-white/[0.03] text-white/58 hover:bg-white/[0.06]'}`}
                      >
                        <span className="mr-2 font-mono text-xs text-white/40">{formatClock(phrase.start)}</span>
                        {phrase.text}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'transcript' ? (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search transcript..."
                    className="min-w-[260px] flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-white outline-none focus:border-white/30"
                  />
                  <button onClick={restoreTranscript} className="rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white/75 hover:bg-white/[0.06]">
                    Restore original transcript
                  </button>
                </div>
                <div className="max-h-[470px] space-y-3 overflow-y-auto pr-2">
                  {settings.edited_transcript
                    .filter((phrase) => !query.trim() || phrase.text.toLowerCase().includes(query.trim().toLowerCase()))
                    .map((phrase) => {
                      const active = currentTime >= phrase.start && currentTime <= phrase.end;
                      return (
                        <div key={phrase.id} className={`rounded-2xl border p-3 transition ${active ? 'border-emerald-300/40 bg-emerald-300/[0.08]' : 'border-white/10 bg-white/[0.03]'}`}>
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <button onClick={() => seekAbsolute(phrase.start)} className="font-mono text-xs font-bold text-white/50 hover:text-white">
                              {formatClock(phrase.start)} - {formatClock(phrase.end)}
                            </button>
                            <label className="flex items-center gap-2 text-xs font-bold text-white/55">
                              <input
                                type="checkbox"
                                checked={phrase.deleted === true}
                                onChange={(event) => updatePhrase(phrase.id, { deleted: event.target.checked })}
                                className="accent-red-400"
                              />
                              Hide from captions
                            </label>
                          </div>
                          <textarea
                            value={phrase.text}
                            onChange={(event) => updatePhrase(phrase.id, { text: event.target.value })}
                            className="min-h-20 w-full resize-y rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm font-semibold leading-5 text-white outline-none focus:border-white/30"
                          />
                        </div>
                      );
                    })}
                </div>
              </div>
            ) : null}

            {tab === 'captions' ? (
              <div className="space-y-5">
                <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  <span className="font-bold text-white">Captions</span>
                  <input type="checkbox" checked={settings.captions_enabled} onChange={(event) => patchSettings({ captions_enabled: event.target.checked })} className="h-5 w-5 accent-emerald-400" />
                </label>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {presetOptions.map((preset) => {
                    const selected = preset.id === settings.caption_preset_id;
                    return (
                      <button
                        key={preset.id}
                        onClick={() => patchSettings({
                          caption_preset_id: preset.id,
                          caption_font_size: preset.captionFontSize,
                          caption_text_color: preset.captionTextColor,
                          caption_highlight_color: preset.captionHighlightColor,
                          caption_background: preset.captionBackgroundBox,
                          caption_position: preset.captionPosition === 'upper' || preset.captionPosition === 'center' ? preset.captionPosition : 'lower-third',
                        })}
                        className={`rounded-2xl border p-3 text-left transition ${selected ? 'border-cyan-300 bg-cyan-300/[0.08]' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                      >
                        <div className="grid aspect-[1.45] place-items-center rounded-xl border border-white/10 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,.12),rgba(255,255,255,.03)_42%,rgba(0,0,0,.55))]">
                          <span style={captionPreviewStyle(preset, { ...settings, caption_preset_id: preset.id, caption_text_color: preset.captionTextColor, caption_highlight_color: preset.captionHighlightColor, caption_background: preset.captionBackgroundBox })}>
                            <span style={{ color: preset.captionHighlightColor }}>THE</span> HOOK
                          </span>
                        </div>
                        <p className="mt-3 text-sm font-black text-white">{preset.name}</p>
                        <p className="text-xs font-semibold text-white/45">{preset.captionFontFamily}</p>
                      </button>
                    );
                  })}
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm font-bold text-white/65">
                    Font size
                    <input type="range" min={8} max={24} value={settings.caption_font_size} onChange={(event) => patchSettings({ caption_font_size: Number(event.target.value) })} className="w-full accent-white" />
                  </label>
                  <label className="space-y-2 text-sm font-bold text-white/65">
                    Max words per phrase
                    <input type="range" min={1} max={6} value={settings.caption_max_words} onChange={(event) => patchSettings({ caption_max_words: Number(event.target.value) })} className="w-full accent-white" />
                  </label>
                  <label className="space-y-2 text-sm font-bold text-white/65">
                    Text color
                    <input type="color" value={settings.caption_text_color} onChange={(event) => patchSettings({ caption_text_color: event.target.value })} className="h-11 w-full rounded-xl border border-white/10 bg-black/30" />
                  </label>
                  <label className="space-y-2 text-sm font-bold text-white/65">
                    Active word color
                    <input type="color" value={settings.caption_highlight_color} onChange={(event) => patchSettings({ caption_highlight_color: event.target.value })} className="h-11 w-full rounded-xl border border-white/10 bg-black/30" />
                  </label>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  {(['upper', 'center', 'lower-third'] as ClipEditSettings['caption_position'][]).map((pos) => (
                    <button key={pos} onClick={() => patchSettings({ caption_position: pos })} className={`rounded-xl border px-4 py-3 text-sm font-bold capitalize ${settings.caption_position === pos ? 'border-white/25 bg-white/[0.1]' : 'border-white/10 hover:bg-white/[0.06]'}`}>
                      {pos.replace('-', ' ')}
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex items-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white/70">
                    <input type="checkbox" checked={settings.caption_word_highlight} onChange={(event) => patchSettings({ caption_word_highlight: event.target.checked })} className="accent-emerald-400" />
                    Word highlighting
                  </label>
                  <label className="flex items-center gap-3 rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white/70">
                    <input type="checkbox" checked={settings.caption_background} onChange={(event) => patchSettings({ caption_background: event.target.checked })} className="accent-emerald-400" />
                    Background box
                  </label>
                </div>
              </div>
            ) : null}

            {tab === 'framing' ? (
              <div className="space-y-5">
                <div className="grid gap-3 md:grid-cols-2">
                  {([
                    ['auto', 'Auto Reframe'],
                    ['center', 'Center Subject'],
                    ['fit', 'Fit Full Frame'],
                    ['manual', 'Manual'],
                  ] as Array<[ClipEditSettings['framing_mode'], string]>).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => patchSettings({ framing_mode: value })}
                      className={`rounded-2xl border px-4 py-4 text-left text-sm font-black transition ${settings.framing_mode === value ? 'border-cyan-300 bg-cyan-300/[0.08]' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="relative mx-auto aspect-[9/16] w-full max-w-[260px] overflow-hidden rounded-xl border border-white/10 bg-black">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_32%,rgba(34,197,94,.18),transparent_38%),linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.02))]" />
                    <div
                      className="absolute rounded-xl border-2 border-cyan-300/85 shadow-[0_0_24px_rgba(103,232,249,.35)]"
                      style={{
                        width: `${clamp(72 / settings.zoom, 38, 78)}%`,
                        height: `${clamp(72 / settings.zoom, 38, 78)}%`,
                        left: `${settings.crop_x * 100}%`,
                        top: `${settings.crop_y * 100}%`,
                        transform: 'translate(-50%, -50%)',
                      }}
                    />
                  </div>
                </div>
                <label className="space-y-2 text-sm font-bold text-white/65">
                  Horizontal position
                  <input type="range" min={0} max={1} step={0.01} value={settings.crop_x} onChange={(event) => patchSettings({ framing_mode: 'manual', crop_x: Number(event.target.value) })} className="w-full accent-cyan-300" />
                </label>
                <label className="space-y-2 text-sm font-bold text-white/65">
                  Vertical position
                  <input type="range" min={0} max={1} step={0.01} value={settings.crop_y} onChange={(event) => patchSettings({ framing_mode: 'manual', crop_y: Number(event.target.value) })} className="w-full accent-cyan-300" />
                </label>
                <label className="space-y-2 text-sm font-bold text-white/65">
                  Zoom
                  <input type="range" min={1} max={2.4} step={0.01} value={settings.zoom} onChange={(event) => patchSettings({ framing_mode: 'manual', zoom: Number(event.target.value) })} className="w-full accent-cyan-300" />
                </label>
                <button onClick={() => patchSettings({ framing_mode: 'auto', crop_x: 0.5, crop_y: 0.34, zoom: 1 })} className="rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white/75 hover:bg-white/[0.06]">
                  Reset framing
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-[18px] border border-white/10 bg-white/[0.035] p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-black text-white">Timeline</p>
            <p className="text-xs font-semibold text-white/45">Selected {formatClock(settings.clip_start_seconds)} - {formatClock(settings.clip_end_seconds)}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void saveDraft()} disabled={!changed || saving} className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-white/75 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45">
              {saving ? 'Saving...' : 'Save Draft'}
            </button>
            <button onClick={() => void rerenderClip()} disabled={!needsRender || rendering} className="rounded-full bg-white px-5 py-2 text-sm font-black text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-45">
              {rendering ? 'Rendering...' : 'Re-render Clip'}
            </button>
          </div>
        </div>

        <div
          ref={timelineRef}
          onPointerDown={(event) => beginTimelineDrag('seek', event)}
          className="relative h-28 cursor-pointer overflow-hidden rounded-2xl border border-white/10 bg-black/35"
        >
          <div className="absolute inset-y-0 bg-emerald-400/18" style={{ left: selectedLeft, width: selectedWidth }} />
          {data.transcript.phrases.map((phrase) => (
            <div
              key={phrase.id}
              className="absolute bottom-3 h-5 rounded-sm bg-white/18"
              title={phrase.text}
              style={{
                left: `${(phrase.start / sourceDuration) * 100}%`,
                width: `${Math.max(0.18, ((phrase.end - phrase.start) / sourceDuration) * 100)}%`,
              }}
            />
          ))}
          <div className="absolute inset-y-0 w-[2px] bg-white shadow-[0_0_16px_rgba(255,255,255,.65)]" style={{ left: playheadLeft }} />
          <button
            onPointerDown={(event) => beginTimelineDrag('start', event)}
            className="absolute top-0 h-full w-4 -translate-x-1/2 cursor-ew-resize rounded-full bg-emerald-300"
            style={{ left: selectedLeft }}
            aria-label="Trim start"
          />
          <button
            onPointerDown={(event) => beginTimelineDrag('end', event)}
            className="absolute top-0 h-full w-4 -translate-x-1/2 cursor-ew-resize rounded-full bg-emerald-300"
            style={{ left: `calc(${selectedLeft} + ${selectedWidth})` }}
            aria-label="Trim end"
          />
        </div>
      </section>
    </main>
  );
}
