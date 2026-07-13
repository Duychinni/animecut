'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULT_CAPTION_PRESET_ID, type CaptionPreset } from '@/lib/caption-presets';
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

type DragMode = 'start' | 'end' | 'seek' | null;
type EditorDebugInfo = {
  code?: string;
  status?: number;
  error?: string;
  detail?: string;
  projectId: string;
  clipId: string;
};

type TranscriptChunk = {
  id: string;
  start: number;
  end: number;
  phrases: TranscriptPhrase[];
  text: string;
  hidden: boolean;
};


function formatClock(totalSeconds: number) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function safeJson(value: unknown) {
  return JSON.stringify(value);
}

function phraseOverlapsClip(phrase: TranscriptPhrase, start: number, end: number) {
  const overlap = Math.min(phrase.end, end) - Math.max(phrase.start, start);
  return overlap >= 0.2;
}

function splitWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function distributeTextAcrossPhrases(text: string, phrases: TranscriptPhrase[]) {
  const words = splitWords(text);
  if (!phrases.length) return [];
  if (!words.length) {
    return phrases.map((phrase) => ({ ...phrase, text: '', deleted: true }));
  }

  const weights = phrases.map((phrase) => Math.max(1, splitWords(phrase.originalText || phrase.text || '').length));
  let remainingWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;

  return phrases.map((phrase, index) => {
    const wordsLeft = words.length - cursor;
    const phrasesLeft = phrases.length - index;
    const count = index === phrases.length - 1
      ? wordsLeft
      : clamp(
        Math.round((wordsLeft * weights[index]) / Math.max(1, remainingWeight)),
        wordsLeft > phrasesLeft ? 1 : 0,
        Math.max(0, wordsLeft - (phrasesLeft - 1)),
      );
    const chunk = words.slice(cursor, cursor + count);
    cursor += count;
    remainingWeight -= weights[index];
    return { ...phrase, text: chunk.join(' '), deleted: chunk.length ? false : true };
  });
}

function buildTranscriptChunks(phrases: TranscriptPhrase[], maxChunks = 5): TranscriptChunk[] {
  const source = phrases.filter((phrase) => (phrase.text || phrase.originalText || '').trim());
  if (!source.length) return [];

  const totalDuration = Math.max(1, (source[source.length - 1]?.end ?? 0) - (source[0]?.start ?? 0));
  const chunkCount = Math.max(1, Math.min(maxChunks, Math.ceil(totalDuration / 12), source.length));
  const phrasesPerChunk = Math.ceil(source.length / chunkCount);

  return Array.from({ length: chunkCount }, (_, index) => {
    const chunkPhrases = source.slice(index * phrasesPerChunk, (index + 1) * phrasesPerChunk);
    const first = chunkPhrases[0];
    const last = chunkPhrases[chunkPhrases.length - 1] ?? first;

    return {
      id: `${first?.id ?? 'chunk'}-${index}`,
      start: first?.start ?? 0,
      end: last?.end ?? first?.end ?? 0,
      phrases: chunkPhrases,
      text: chunkPhrases.map((phrase) => phrase.text).join(' '),
      hidden: chunkPhrases.length > 0 && chunkPhrases.every((phrase) => phrase.deleted === true),
    };
  }).filter((chunk) => chunk.phrases.length > 0);
}

function captionPreviewStyle(preset: CaptionPreset | undefined, settings: ClipEditSettings) {
  const textColor = settings.caption_text_color || preset?.captionTextColor || '#ffffff';
  const strokeColor = preset?.captionStrokeColor || '#000000';
  const fontFamily = preset?.captionFontFamily || 'Arial Black';
  const fontSize = settings.caption_font_size * 2.2;
  const shadowMap: Record<string, string> = {
    'black-heavy': '0 3px 0 #000, 0 8px 18px rgba(0,0,0,.9)',
    'heavy-shadow': '0 4px 0 #000, 3px 6px 0 rgba(0,0,0,.65), 0 10px 20px rgba(0,0,0,.85)',
    'subtle-shadow': '0 2px 5px rgba(0,0,0,.8)',
    'neon-glow': `0 0 9px ${preset?.captionHighlightColor || '#FF4FD8'}, 0 5px 14px rgba(0,0,0,.9)`,
    'purple-glow': `0 0 10px ${preset?.captionHighlightColor || '#A855F7'}, 0 5px 14px rgba(0,0,0,.9)`,
    'yellow-glow': '0 3px 0 #000, 0 0 8px rgba(255,216,77,.8), 0 8px 18px rgba(0,0,0,.9)',
    'soft-glow': `0 0 7px ${preset?.captionHighlightColor || '#5DE4FF'}, 0 6px 16px rgba(0,0,0,.86)`,
    'red-pop': '0 3px 0 #000, 3px 5px 0 rgba(255,59,48,.72), 0 8px 18px rgba(0,0,0,.9)',
  };
  return {
    color: textColor,
    fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: 950,
    letterSpacing: 0,
    lineHeight: 1.02,
    textTransform: 'uppercase' as const,
    WebkitTextStroke: settings.caption_background ? '0 transparent' : `${Math.max(1, Math.round(fontSize * 0.08))}px ${strokeColor}`,
    textShadow: settings.caption_background ? '0 4px 12px rgba(0,0,0,.28)' : shadowMap[preset?.captionShadow || ''] || shadowMap['black-heavy'],
    backgroundColor: settings.caption_background ? '#FFFFFF' : undefined,
    padding: settings.caption_background ? '0.2em 0.42em' : undefined,
    borderRadius: settings.caption_background ? '0.28em' : undefined,
  };
}

function captionPositionClass(position: ClipEditSettings['caption_position']) {
  if (position === 'upper') return 'top-[16%]';
  if (position === 'center') return 'top-1/2 -translate-y-1/2';
  return 'bottom-[15%]';
}

function cropPreviewStyle(settings: ClipEditSettings) {
  const zoom = settings.framing_mode === 'fit' ? 1 : settings.zoom;
  const x = settings.framing_mode === 'center' || settings.framing_mode === 'fit' ? 0.5 : settings.crop_x;
  const y = settings.framing_mode === 'center' || settings.framing_mode === 'fit' ? 0.5 : settings.crop_y;

  return {
    objectFit: settings.framing_mode === 'fit' ? 'contain' : 'cover',
    transform: `scale(${zoom}) translate(${(0.5 - x) * 22}%, ${(0.5 - y) * 22}%)`,
    transformOrigin: 'center',
  } satisfies CSSProperties;
}

export function ClipEditor({ projectId, clipId }: { projectId: string; clipId: string }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const renderScheduleRef = useRef<number | null>(null);
  const [data, setData] = useState<EditorData | null>(null);
  const [settings, setSettings] = useState<ClipEditSettings | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<EditorDebugInfo | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewDurationSeconds, setPreviewDurationSeconds] = useState(0);
  const [paused, setPaused] = useState(true);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [cutMode, setCutMode] = useState(false);

  const previewUrl = data?.source.previewUrl || data?.clip.signedUrl || data?.source.fallbackClipUrl || null;
  const previewUsesSource = Boolean(previewUrl && data?.source.previewUrl && previewUrl === data.source.previewUrl && previewUrl !== data?.clip.signedUrl);
  const sourceDuration = Math.max(1, data?.source.durationSeconds ?? settings?.clip_end_seconds ?? 90);
  const changed = Boolean(settings && baseline && safeJson(settings) !== baseline);
  const needsRender = changed || data?.clip.editStatus === 'draft' || data?.clip.editStatus === 'error';

  const activePreset = useMemo(() => {
    if (!data || !settings) return undefined;
    return data.presets.find((preset) => preset.id === settings.caption_preset_id) ?? data.presets[0];
  }, [data, settings]);

  const presetOptions = useMemo(() => {
    if (!data) return [];
    const defaultPreset = data.presets.find((preset) => preset.id === DEFAULT_CAPTION_PRESET_ID);
    return [
      ...(defaultPreset ? [defaultPreset] : []),
      ...data.presets.filter((preset) => preset.id !== DEFAULT_CAPTION_PRESET_ID),
    ].slice(0, 9);
  }, [data]);

  const clipTranscript = useMemo(() => {
    if (!settings) return [];
    const renderedClipEnd = !previewUsesSource && previewDurationSeconds > 0
      ? Math.min(settings.clip_end_seconds, settings.clip_start_seconds + previewDurationSeconds + 0.2)
      : settings.clip_end_seconds;
    return settings.edited_transcript.filter((phrase) => phraseOverlapsClip(phrase, settings.clip_start_seconds, renderedClipEnd));
  }, [previewDurationSeconds, previewUsesSource, settings]);

  const transcriptChunks = useMemo(() => buildTranscriptChunks(clipTranscript, 5), [clipTranscript]);
  const clipTranscriptText = useMemo(() => (
    transcriptChunks.map((chunk) => chunk.text.trim()).filter(Boolean).join('\n\n')
  ), [transcriptChunks]);
  const clipTranscriptHidden = clipTranscript.length > 0 && clipTranscript.every((phrase) => phrase.deleted === true);
  const activeCaptionText = useMemo(() => {
    if (!settings?.captions_enabled || clipTranscriptHidden) return '';
    const activePhrase = clipTranscript.find((phrase) => (
      phrase.deleted !== true
      && currentTime >= Math.max(settings.clip_start_seconds, phrase.start)
      && currentTime <= Math.min(settings.clip_end_seconds, phrase.end)
    ));
    const text = activePhrase?.text || clipTranscript.find((phrase) => phrase.deleted !== true)?.text || '';
    return splitWords(text).slice(0, Math.max(1, settings.caption_max_words)).join(' ');
  }, [clipTranscript, clipTranscriptHidden, currentTime, settings]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clips/${clipId}/edit`, { cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) {
      const debug = {
        code: typeof json?.code === 'string' ? json.code : undefined,
        status: res.status,
        error: typeof json?.error === 'string' ? json.error : 'Could not load clip editor',
        detail: typeof json?.detail === 'string' ? json.detail : undefined,
        projectId,
        clipId,
      } satisfies EditorDebugInfo;
      const err = new Error(debug.error);
      (err as Error & { debug?: EditorDebugInfo }).debug = debug;
      throw err;
    }
    setDebugInfo(null);
    setData(json);
    setSettings(json.settings);
    setBaseline(safeJson(json.settings));
    setCurrentTime(Number(json.settings.clip_start_seconds ?? 0));
    setRendering(json.clip?.editStatus === 'rendering');
  }, [clipId, projectId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load()
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Could not load clip editor');
        setDebugInfo((err as Error & { debug?: EditorDebugInfo })?.debug ?? {
          error: err instanceof Error ? err.message : 'Could not load clip editor',
          projectId,
          clipId,
        });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clipId, load, projectId]);

  function handleBack() {
    if (changed && !window.confirm('Leave without saving your clip edits?')) return;
    router.push(`/dashboard/projects/${projectId}`);
  }

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
        await fetch(`/api/jobs/process?exportId=${encodeURIComponent(clipId)}`, { method: 'POST', cache: 'no-store' }).catch(() => null);
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
    }, 1500);
    return () => window.clearInterval(timer);
  }, [clipId, projectId, rendering, router]);

  useEffect(() => {
    if (!settings || !videoRef.current) return;
    const video = videoRef.current;
    const target = previewUsesSource ? settings.clip_start_seconds : 0;
    if (Math.abs(video.currentTime - target) > 0.5) {
      video.currentTime = target;
    }
  }, [previewUsesSource, settings?.clip_start_seconds]);

  function patchSettings(patch: Partial<ClipEditSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function patchTimes(start: number, end: number) {
    if (!settings) return;
    const maxEnd = Math.max(10, sourceDuration);
    const safeStart = clamp(start, 0, Math.max(0, maxEnd - 10));
    const safeEnd = clamp(end, safeStart + 10, Math.min(maxEnd, safeStart + 90));
    patchSettings({ clip_start_seconds: safeStart, clip_end_seconds: safeEnd });
    if (currentTime < safeStart || currentTime > safeEnd) {
      seekAbsolute(safeStart);
    }
  }

  function updateClipTranscriptText(text: string) {
    if (!settings) return;
    const paragraphs = text.split(/\n\s*\n/);
    const distributed = transcriptChunks.flatMap((chunk, index) => (
      distributeTextAcrossPhrases(paragraphs[index] ?? '', chunk.phrases)
    ));
    const updates = new Map(distributed.map((phrase) => [phrase.id, phrase]));
    patchSettings({
      edited_transcript: settings.edited_transcript.map((phrase) => updates.get(phrase.id) ?? phrase),
    });
  }

  function removeTimelineChunk(chunk: TranscriptChunk) {
    if (!settings) return;
    const start = clamp(chunk.start, settings.clip_start_seconds, settings.clip_end_seconds);
    const end = clamp(chunk.end, start, settings.clip_end_seconds);
    if (end - start < 0.15) return;
    const ids = new Set(chunk.phrases.map((phrase) => phrase.id));
    const nextSettings: ClipEditSettings = {
      ...settings,
      removed_ranges: [...settings.removed_ranges, { start, end }]
        .sort((a, b) => a.start - b.start),
      edited_transcript: settings.edited_transcript.map((phrase) => (
        ids.has(phrase.id) ? { ...phrase, deleted: true } : phrase
      )),
    };
    setSettings(nextSettings);
    setCutMode(false);
    if (currentTime >= start && currentTime < end) seekAbsolute(end);
    setToast('Segment removed. Updating export...');
    scheduleRender(nextSettings, 100);
  }

  function scheduleRender(nextSettings: ClipEditSettings, delay = 700) {
    if (renderScheduleRef.current !== null) window.clearTimeout(renderScheduleRef.current);
    renderScheduleRef.current = window.setTimeout(() => {
      renderScheduleRef.current = null;
      void rerenderClip(nextSettings);
    }, delay);
  }

  function selectCaptionPreset(preset: CaptionPreset) {
    if (!settings) return;
    const nextSettings: ClipEditSettings = {
      ...settings,
      caption_preset_id: preset.id,
      caption_font_size: preset.captionFontSize,
      caption_text_color: preset.captionTextColor,
      caption_highlight_color: preset.captionHighlightColor,
      caption_background: preset.captionBackgroundBox,
      caption_word_highlight: preset.captionWordHighlight,
      caption_max_words: preset.captionMaxWords,
      caption_position: preset.captionPosition === 'upper' || preset.captionPosition === 'center' ? preset.captionPosition : 'lower-third',
    };
    setSettings(nextSettings);
    setToast('Caption preview updated. Updating export...');
    scheduleRender(nextSettings);
  }

  useEffect(() => () => {
    if (renderScheduleRef.current !== null) window.clearTimeout(renderScheduleRef.current);
  }, []);

  useEffect(() => {
    if (!settings || !baseline || !changed || saving || rendering) return;
    const timer = window.setTimeout(() => {
      void saveDraft(false);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [baseline, changed, rendering, saving, settings]);

  useEffect(() => {
    if (!settings?.removed_ranges.length) return;
    const removed = settings.removed_ranges.find((range) => currentTime >= range.start && currentTime < range.end);
    if (removed) seekAbsolute(removed.end);
  }, [currentTime, settings?.removed_ranges]);

  function setClipTranscriptHidden(hidden: boolean) {
    if (!settings) return;
    const ids = new Set(clipTranscript.map((phrase) => phrase.id));
    patchSettings({
      edited_transcript: settings.edited_transcript.map((phrase) => ids.has(phrase.id) ? { ...phrase, deleted: hidden } : phrase),
    });
  }

  function restoreTranscript() {
    if (!data || !settings) return;
    const originals = new Map(data.transcript.phrases.map((phrase) => [phrase.id, phrase]));
    patchSettings({
      removed_ranges: [],
      edited_transcript: settings.edited_transcript.map((phrase) => {
        if (!phraseOverlapsClip(phrase, settings.clip_start_seconds, settings.clip_end_seconds)) return phrase;
        const original = originals.get(phrase.id);
        return { ...phrase, text: original?.originalText || original?.text || phrase.originalText || phrase.text, deleted: false };
      }),
    });
  }

  function seekAbsolute(seconds: number) {
    const video = videoRef.current;
    const safe = clamp(seconds, 0, sourceDuration);
    setCurrentTime(safe);
    if (!video) return;
    if (previewUsesSource) {
      video.currentTime = safe;
      return;
    }
    const relative = clamp(safe - (settings?.clip_start_seconds ?? 0), 0, Math.max(0, (settings?.clip_end_seconds ?? safe) - (settings?.clip_start_seconds ?? 0)));
    video.currentTime = relative;
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

  async function rerenderClip(nextSettings: ClipEditSettings | null = settings) {
    if (!nextSettings) return;
    setRendering(true);
    setError(null);
    try {
      const res = await fetch(`/api/clips/${clipId}/rerender`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: nextSettings }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(String(json?.error || 'Could not start render'));
      setData(json);
      setSettings(json.settings);
      setBaseline(safeJson(json.settings));
      await fetch(`/api/jobs/process?exportId=${encodeURIComponent(clipId)}`, { method: 'POST', cache: 'no-store' }).catch(() => null);
      setToast('Rendering updated clip');
    } catch (err) {
      setRendering(false);
      setError(err instanceof Error ? err.message : 'Could not start render');
    }
  }

  function timelineSeconds(event: PointerEvent | ReactPointerEvent<HTMLElement>) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    if (!settings) return 0;
    const duration = Math.max(0.1, settings.clip_end_seconds - settings.clip_start_seconds);
    return settings.clip_start_seconds + (x / rect.width) * duration;
  }

  function beginTimelineDrag(mode: DragMode, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
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
  }, [dragMode, settings]);

  if (loading) {
    return (
      <main className="mx-auto grid min-h-[calc(100vh-92px)] w-full max-w-7xl place-items-center px-6 py-10 text-white">
        <div className="w-full max-w-5xl animate-pulse rounded-[20px] border border-white/10 bg-white/[0.03] p-8">
          <div className="h-6 w-64 rounded bg-white/10" />
          <div className="mt-8 grid gap-6 xl:grid-cols-[0.9fr_0.8fr_0.65fr]">
            <div className="h-[620px] rounded-[18px] bg-white/10" />
            <div className="aspect-[9/16] rounded-[18px] bg-white/10" />
            <div className="h-[620px] rounded-[18px] bg-white/10" />
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
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button onClick={() => router.push(`/dashboard/projects/${projectId}`)} className="rounded-full bg-white px-5 py-2 text-sm font-bold text-black">
              Back to project
            </button>
            {debugInfo ? (
              <button
                onClick={() => void navigator.clipboard?.writeText(JSON.stringify(debugInfo, null, 2))}
                className="rounded-full border border-white/15 px-5 py-2 text-sm font-bold text-white/80 transition hover:bg-white/[0.07] hover:text-white"
              >
                Copy debug
              </button>
            ) : null}
          </div>
        </div>
      </main>
    );
  }

  const clipDuration = Math.max(0, settings.clip_end_seconds - settings.clip_start_seconds);
  const timelineDuration = Math.max(0.1, clipDuration);
  const playheadLeft = `${clamp(((currentTime - settings.clip_start_seconds) / timelineDuration) * 100, 0, 100)}%`;
  const rulerTicks = Array.from({ length: 7 }, (_, index) => ({
    index,
    value: index === 6 ? timelineDuration : (timelineDuration / 6) * index,
    percent: index === 6 ? 100 : ((timelineDuration / 6) * index / timelineDuration) * 100,
  }));
  const timelineFrameBlocks = Array.from({ length: Math.max(18, Math.min(54, Math.round(timelineDuration * 0.9))) }, (_, index) => index);
  const timelinePosterUrl = data.clip.posterUrl ?? data.source.posterUrl ?? '';
  const cropWindowWidth = clamp(100 / Math.max(1, settings.zoom), 36, 100);
  const cropCenter = settings.framing_mode === 'center' || settings.framing_mode === 'fit' ? 50 : settings.crop_x * 100;
  const cropWindowLeft = clamp(cropCenter - cropWindowWidth / 2, 0, 100 - cropWindowWidth);
  const audioBars = Array.from({ length: 120 }, (_, index) => {
    const height = 18 + ((index * 17) % 31);
    return height;
  });

  return (
    <main className="mx-auto w-full max-w-[1680px] px-5 py-4 text-white">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-white/42">Clip Editor</p>
        </div>
        <div className="flex items-center gap-2">
          {toast ? <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-200">{toast}</span> : null}
          <button onClick={handleBack} className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-white/75 transition hover:bg-white/[0.06] hover:text-white">
            Back to project
          </button>
        </div>
      </div>

      {error ? (
        <div className="mb-3 rounded-2xl border border-red-400/25 bg-red-500/[0.08] px-4 py-2 text-sm font-semibold text-red-100">
          {error}
        </div>
      ) : null}

      <section className="grid h-[720px] justify-center gap-3 xl:grid-cols-[minmax(420px,500px)_minmax(560px,640px)_minmax(280px,330px)]">
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-white/[0.055] bg-[#1b1e24]">
          <div className="border-b border-white/10 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-white/40">Transcript</p>
                <p className="mt-1 text-sm font-semibold text-white/68">Edit this reel's caption text.</p>
              </div>
              <button onClick={restoreTranscript} className="rounded-full border border-white/10 px-3 py-2 text-xs font-bold text-white/72 hover:bg-white/[0.06]">
                Reset
              </button>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#25282f] px-4 py-3 text-xs font-bold text-white/60">
              <button onClick={() => seekAbsolute(settings.clip_start_seconds)} className="font-mono hover:text-white">
                {formatClock(0)} - {formatClock(clipDuration)}
              </button>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={clipTranscriptHidden}
                  onChange={(event) => setClipTranscriptHidden(event.target.checked)}
                  className="accent-red-400"
                />
                Hide captions
              </label>
            </div>
          </div>
          <div className="min-h-0 flex-1 bg-[#20232a] p-4">
            {clipTranscript.length ? (
              <textarea
                value={clipTranscriptText}
                onChange={(event) => updateClipTranscriptText(event.target.value)}
                onFocus={() => seekAbsolute(settings.clip_start_seconds)}
                spellCheck
                className="h-full w-full resize-none rounded-2xl border border-white/[0.08] bg-[#30343c] px-4 py-4 text-base font-semibold leading-8 text-white outline-none transition focus:border-white/25"
              />
            ) : (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm font-semibold text-white/58">
                No caption text found inside this reel. Extend the clip handles or reset the AI selection to bring transcript text back into range.
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-white/[0.035] bg-[#181a1f]">
          <h1 className="flex min-h-[58px] items-center justify-center border-b border-white/10 px-5 py-3 text-center text-base font-black leading-tight text-white">
            {data.clip.title}
          </h1>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-start overflow-hidden p-4">
            <div className="relative aspect-[9/16] h-full max-h-[665px] w-auto max-w-[380px] overflow-hidden rounded-[15px] border border-white/[0.04] bg-black shadow-[0_24px_90px_rgba(0,0,0,.45)]">
              {previewUrl ? (
                <video
                  key={previewUrl}
                  ref={videoRef}
                  src={previewUrl}
                  poster={data.clip.posterUrl ?? data.source.posterUrl ?? undefined}
                  controls
                  controlsList="nofullscreen nodownload noremoteplayback"
                  disablePictureInPicture
                  playsInline
                  preload="metadata"
                  className="h-full w-full bg-black transition-transform duration-200"
                  style={cropPreviewStyle(settings)}
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    setPreviewDurationSeconds(Number.isFinite(video.duration) ? video.duration : 0);
                    video.currentTime = previewUsesSource ? settings.clip_start_seconds : 0;
                  }}
                  onTimeUpdate={(event) => {
                    const video = event.currentTarget;
                    const absolute = previewUsesSource ? video.currentTime : settings.clip_start_seconds + video.currentTime;
                    setCurrentTime(clamp(absolute, 0, sourceDuration));
                    if (previewUsesSource && absolute >= settings.clip_end_seconds) {
                      video.pause();
                      setPaused(true);
                    }
                  }}
                  onPlay={() => setPaused(false)}
                  onPause={() => setPaused(true)}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-white/45">Preview unavailable</div>
              )}

              {previewUsesSource && settings.captions_enabled && activeCaptionText ? (
                <div className={`pointer-events-none absolute left-4 right-4 z-20 text-center ${captionPositionClass(settings.caption_position)}`}>
                  <span
                    style={captionPreviewStyle(activePreset, settings)}
                    className={`inline-block max-w-full break-words ${settings.caption_background ? 'rounded-lg px-3 py-1' : ''}`}
                  >
                    {settings.caption_word_highlight ? (
                      <>
                        <span style={{ color: settings.caption_highlight_color }}>{splitWords(activeCaptionText)[0]}</span>
                        {splitWords(activeCaptionText).length > 1 ? ` ${splitWords(activeCaptionText).slice(1).join(' ')}` : ''}
                      </>
                    ) : activeCaptionText}
                  </span>
                </div>
              ) : null}

              {rendering ? (
                <span className="absolute right-3 top-3 rounded-full bg-emerald-400/12 px-3 py-1 text-xs font-bold text-emerald-200 backdrop-blur">
                  Rendering
                </span>
              ) : null}

              {paused ? (
                <button
                  type="button"
                  onClick={() => void togglePlay()}
                  className="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 shadow-[0_10px_26px_rgba(0,0,0,.35)] backdrop-blur transition hover:scale-105"
                  aria-label="Play preview"
                >
                  <span className="ml-1 h-0 w-0 border-y-[12px] border-y-transparent border-l-[18px] border-l-white" />
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-white/[0.035] bg-[#111318]/95">
          <div className="border-b border-white/10 px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">Project</p>
            <p className="mt-1 text-sm font-semibold text-white">Clip settings</p>
          </div>

          <div className="min-h-0 space-y-4 overflow-y-auto p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-black text-white">Caption style</p>
                <label className="flex items-center gap-2 text-xs font-bold text-white/58">
                  <input type="checkbox" checked={settings.captions_enabled} onChange={(event) => patchSettings({ captions_enabled: event.target.checked })} className="accent-emerald-400" />
                  On
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {presetOptions.map((preset) => {
                  const selected = preset.id === settings.caption_preset_id;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => selectCaptionPreset(preset)}
                      className={`rounded-2xl border p-2 text-left transition ${selected ? 'border-cyan-300 bg-cyan-300/[0.08]' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]'}`}
                    >
                      <div className="grid aspect-[1.45] place-items-center rounded-xl border border-white/10 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,.12),rgba(255,255,255,.03)_42%,rgba(0,0,0,.55))]">
                        <span style={captionPreviewStyle(preset, { ...settings, caption_preset_id: preset.id, caption_text_color: preset.captionTextColor, caption_highlight_color: preset.captionHighlightColor, caption_background: preset.captionBackgroundBox })}>
                          <span style={{ color: preset.captionHighlightColor }}>THE</span> HOOK
                        </span>
                      </div>
                      <p className="mt-2 truncate text-xs font-black text-white">{preset.name}</p>
                    </button>
                  );
                })}
              </div>
            </div>

          </div>
        </aside>
      </section>

      <section className="mx-auto mt-3 w-full max-w-[1360px] overflow-hidden rounded-[12px] border border-white/[0.035] bg-[#111318]/95">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-3 py-2">
          <div>
            <p className="text-sm font-black text-white">Timeline</p>
            <p className="text-xs font-semibold text-white/45">
              Clip {formatClock(0)} - {formatClock(clipDuration)} ({formatClock(clipDuration)})
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-white/45">{saving ? 'Saving changes...' : changed ? 'Waiting to save...' : 'Changes saved'}</span>
            <button
              type="button"
              onClick={() => setCutMode((value) => !value)}
              className={`grid h-9 w-9 place-items-center rounded-md border text-lg transition ${cutMode ? 'border-orange-300 bg-orange-300/15 text-orange-200' : 'border-white/10 text-white/72 hover:bg-white/[0.06]'}`}
              aria-label="Cut a timeline segment"
              title="Select a text block to remove that segment"
            >
              <span aria-hidden="true">&#9986;</span>
            </button>
            <button onClick={() => void rerenderClip()} disabled={!needsRender || rendering} className="rounded-full bg-white px-5 py-2 text-sm font-black text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-45">
              {rendering ? 'Updating clip...' : 'Export update'}
            </button>
          </div>
        </div>

        <div className="px-3 py-2">
          <div className="relative grid h-[176px] grid-cols-[54px_1fr] overflow-hidden rounded-2xl border border-white/10 bg-black/35">
            <div className="border-r border-white/[0.08] bg-black/25 pt-[31px] text-[10px] font-black uppercase tracking-[0.12em] text-white/36">
              {[
                ['Text', 'h-[34px]'],
                ['Video', 'h-[62px]'],
                ['Audio', 'h-[43px]'],
              ].map(([label, heightClass]) => (
                <div key={label} className={`flex ${heightClass} items-center justify-center border-b border-white/[0.035]`}>
                  {label}
                </div>
              ))}
            </div>

            <div
              ref={timelineRef}
              onPointerDown={(event) => beginTimelineDrag('seek', event)}
              className="relative cursor-pointer overflow-hidden"
            >
              <div className="relative h-[31px] border-b border-white/[0.08] bg-white/[0.02]">
                {rulerTicks.map((tick) => (
                  <div
                    key={tick.index}
                    className={`absolute top-0 h-full text-[10px] font-mono font-bold text-white/38 ${tick.index === 6 ? 'border-r border-white/[0.12] pr-1 text-right' : 'border-l border-white/[0.12] pl-1'}`}
                    style={tick.index === 6 ? { right: 0 } : { left: `${tick.percent}%` }}
                  >
                    {formatClock(tick.value)}
                  </div>
                ))}
              </div>

              <div className="absolute inset-x-0 top-[34px] h-[30px] bg-orange-400/10" />
              {transcriptChunks.map((chunk) => {
                const start = clamp(chunk.start - settings.clip_start_seconds, 0, timelineDuration);
                const end = clamp(chunk.end - settings.clip_start_seconds, 0, timelineDuration);
                return (
                  <button
                    type="button"
                    key={chunk.id}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      if (cutMode) removeTimelineChunk(chunk);
                      else seekAbsolute(chunk.start);
                    }}
                    className={`absolute top-[38px] h-[22px] overflow-hidden rounded-[4px] px-2 text-left text-[9px] font-black leading-[22px] text-black/78 ${cutMode ? 'cursor-crosshair bg-orange-200 ring-1 ring-orange-100' : 'bg-orange-300/80'}`}
                    title={chunk.text}
                    style={{
                      left: `${(start / timelineDuration) * 100}%`,
                      width: `${Math.max(0.45, ((end - start) / timelineDuration) * 100)}%`,
                    }}
                  >
                    {chunk.text}
                  </button>
                );
              })}

              <div className="absolute inset-x-0 top-[69px] h-[58px] bg-cyan-300/10" />
              <div className="absolute inset-x-0 top-[72px] flex h-[52px] items-stretch gap-[3px] px-2">
                {timelineFrameBlocks.map((index) => {
                  const framePercent = timelineFrameBlocks.length <= 1 ? 50 : (index / (timelineFrameBlocks.length - 1)) * 100;
                  return (
                    <span
                      key={index}
                      className="min-w-0 flex-1 rounded-[4px] border border-cyan-100/10 bg-cyan-300/28"
                      style={timelinePosterUrl ? {
                        backgroundImage: `linear-gradient(180deg, rgba(3,8,14,.18), rgba(3,8,14,.28)), url("${timelinePosterUrl}")`,
                        backgroundPosition: `${framePercent}% center`,
                        backgroundSize: 'cover',
                      } : undefined}
                    />
                  );
                })}
              </div>
              <div
                className="pointer-events-none absolute top-[72px] h-[52px] rounded-md border border-emerald-300/55 bg-emerald-300/18 shadow-[0_0_24px_rgba(110,231,183,.12)]"
                style={{ left: `${cropWindowLeft}%`, width: `${cropWindowWidth}%` }}
              />

              <div className="absolute inset-x-0 bottom-2 flex h-9 items-end gap-[2px] px-2">
                {audioBars.map((height, index) => (
                  <span
                    key={index}
                    className="flex-1 rounded-t bg-sky-300/55"
                    style={{ height: `${height}%` }}
                  />
                ))}
              </div>

              {settings.removed_ranges.map((range, index) => (
                <div
                  key={`${range.start}-${range.end}-${index}`}
                  className="pointer-events-none absolute bottom-0 top-[31px] border-x border-red-300/70 bg-red-500/25"
                  style={{
                    left: `${clamp(((range.start - settings.clip_start_seconds) / timelineDuration) * 100, 0, 100)}%`,
                    width: `${clamp(((range.end - range.start) / timelineDuration) * 100, 0, 100)}%`,
                  }}
                />
              ))}

              <div className="absolute inset-y-0 w-[2px] bg-white shadow-[0_0_16px_rgba(255,255,255,.65)]" style={{ left: playheadLeft }} />
              <button
                onPointerDown={(event) => beginTimelineDrag('start', event)}
                className="absolute top-[31px] h-[145px] w-4 -translate-x-1/2 cursor-ew-resize rounded-full bg-emerald-300"
                style={{ left: '0%' }}
                aria-label="Trim start"
              />
              <button
                onPointerDown={(event) => beginTimelineDrag('end', event)}
                className="absolute top-[31px] h-[145px] w-4 -translate-x-1/2 cursor-ew-resize rounded-full bg-emerald-300"
                style={{ left: '100%' }}
                aria-label="Trim end"
              />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
