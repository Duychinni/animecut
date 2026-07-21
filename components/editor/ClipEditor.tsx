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

type DragMode = 'start' | 'end' | 'seek' | 'selection-start' | 'selection-end' | null;
type EditorTool = 'trim' | 'crop' | 'captions' | 'audio';
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

type TimelineRange = {
  id: string;
  start: number;
  end: number;
};

type TimelineFilmstrip = {
  key: string;
  frames: string[];
  captureFailed: boolean;
};

function TimelineVideoThumbnail({ src, time }: { src: string; time: number }) {
  return (
    <video
      src={src}
      muted
      playsInline
      preload="metadata"
      disablePictureInPicture
      className="pointer-events-none h-full min-w-0 flex-1 bg-black object-cover opacity-0 transition-opacity duration-150"
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        video.currentTime = clamp(time, 0, Math.max(0, video.duration - 0.05));
      }}
      onSeeked={(event) => {
        event.currentTarget.style.opacity = '1';
      }}
      aria-hidden="true"
    />
  );
}


function formatClock(totalSeconds: number) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildTimelineViewport(start: number, end: number) {
  return { start, end: Math.max(start + 0.1, end) };
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
  const fontSize = settings.caption_font_size * 2.55;
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
  const editableClipBoundsRef = useRef<TimelineRange | null>(null);
  const cropDragRef = useRef<{ clientX: number; clientY: number; cropX: number; cropY: number } | null>(null);
  const [data, setData] = useState<EditorData | null>(null);
  const [settings, setSettings] = useState<ClipEditSettings | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<EditorDebugInfo | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewDurationSeconds, setPreviewDurationSeconds] = useState(0);
  const [paused, setPaused] = useState(true);
  const [dragMode, setDragMode] = useState<DragMode>(null);
  const [selectedRange, setSelectedRange] = useState<TimelineRange | null>(null);
  const [timelineViewport, setTimelineViewport] = useState({ start: 0, end: 1 });
  const [timelineFilmstrip, setTimelineFilmstrip] = useState<TimelineFilmstrip>({ key: '', frames: [], captureFailed: false });
  const [activeTool, setActiveTool] = useState<EditorTool>('trim');
  const [cropDragging, setCropDragging] = useState(false);

  const previewUrl = data?.source.previewUrl || data?.clip.signedUrl || data?.source.fallbackClipUrl || null;
  const previewUsesSource = Boolean(previewUrl && data?.source.previewUrl && previewUrl === data.source.previewUrl && previewUrl !== data?.clip.signedUrl);
  const sourceDuration = Math.max(1, data?.source.durationSeconds ?? settings?.clip_end_seconds ?? 90);
  const clipStartSeconds = settings?.clip_start_seconds;
  const clipEndSeconds = settings?.clip_end_seconds;
  const changed = Boolean(settings && baseline && safeJson(settings) !== baseline);
  const needsRender = changed || data?.clip.editStatus === 'draft' || data?.clip.editStatus === 'error';
  const editableTimelineEnd = editableClipBoundsRef.current?.end ?? clipEndSeconds ?? timelineViewport.end;
  const editableTimelineDuration = Math.max(0.1, editableTimelineEnd - timelineViewport.start);
  const filmstripFrameCount = clamp(Math.ceil(editableTimelineDuration / 3), 8, 16);
  const timelineSampleTimes = useMemo(() => Array.from({ length: filmstripFrameCount }, (_, index) => {
    const ratio = (index + 0.5) / filmstripFrameCount;
    return previewUsesSource
      ? timelineViewport.start + editableTimelineDuration * ratio
      : editableTimelineDuration * ratio;
  }), [editableTimelineDuration, filmstripFrameCount, previewUsesSource, timelineViewport.start]);
  const timelineFilmstripKey = `${previewUrl ?? ''}|${previewUsesSource ? 'source' : 'clip'}|${timelineViewport.start.toFixed(3)}|${timelineViewport.end.toFixed(3)}|${filmstripFrameCount}`;

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
  const timelineChunks = useMemo(() => {
    if (!settings) return [];
    const phrases = settings.edited_transcript.filter((phrase) => (
      phraseOverlapsClip(phrase, timelineViewport.start, timelineViewport.end)
    ));
    return buildTranscriptChunks(phrases, Math.max(5, Math.ceil((timelineViewport.end - timelineViewport.start) / 8)));
  }, [settings, timelineViewport]);
  const timelineSegments = useMemo(() => {
    if (!settings) return [];
    const boundaries = [
      settings.clip_start_seconds,
      ...settings.cut_points.filter((point) => point > settings.clip_start_seconds && point < settings.clip_end_seconds),
      settings.clip_end_seconds,
    ].sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((start, index) => ({
      id: `segment-${index}-${start.toFixed(3)}`,
      start,
      end: boundaries[index + 1],
    }));
  }, [settings]);
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
    editableClipBoundsRef.current = {
      id: 'editable-clip-bounds',
      start: Number(json.settings.clip_start_seconds ?? 0),
      end: Number(json.settings.clip_end_seconds ?? 30),
    };
    setBaseline(safeJson(json.settings));
    setCurrentTime(Number(json.settings.clip_start_seconds ?? 0));
    setTimelineViewport(buildTimelineViewport(
      Number(json.settings.clip_start_seconds ?? 0),
      Number(json.settings.clip_end_seconds ?? 30),
    ));
    setSelectedRange(null);
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
      if (event.key === 'Escape' && selectedRange) {
        event.preventDefault();
        setSelectedRange(null);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        handleBack();
      }
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
    if (clipStartSeconds === undefined || !videoRef.current) return;
    const video = videoRef.current;
    const target = previewUsesSource ? clipStartSeconds : 0;
    if (Math.abs(video.currentTime - target) > 0.5) {
      video.currentTime = target;
    }
  }, [clipStartSeconds, previewUsesSource]);

  useEffect(() => {
    if (clipStartSeconds === undefined || clipEndSeconds === undefined || dragMode) return;
    const editableBounds = editableClipBoundsRef.current;
    setTimelineViewport(buildTimelineViewport(
      editableBounds?.start ?? clipStartSeconds,
      editableBounds?.end ?? clipEndSeconds,
    ));
  }, [clipEndSeconds, clipStartSeconds, dragMode]);

  useEffect(() => {
    if (!previewUrl || !timelineSampleTimes.length) return;
    let cancelled = false;
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';

    const waitForMetadata = () => new Promise<void>((resolve, reject) => {
      if (video.readyState >= 1) {
        resolve();
        return;
      }
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('timeline_video_load_failed')), { once: true });
    });

    const seekTo = (time: number) => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('timeline_seek_timeout')), 3500);
      video.addEventListener('seeked', () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
      video.currentTime = clamp(time, 0, Math.max(0, video.duration - 0.05));
    });

    void (async () => {
      try {
        video.src = previewUrl;
        await waitForMetadata();
        const canvas = document.createElement('canvas');
        canvas.width = 120;
        canvas.height = 80;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('timeline_canvas_unavailable');
        const frames: string[] = [];

        for (const time of timelineSampleTimes) {
          if (cancelled) return;
          await seekTo(time);
          const sourceWidth = Math.max(1, video.videoWidth);
          const sourceHeight = Math.max(1, video.videoHeight);
          const targetAspect = canvas.width / canvas.height;
          const sourceAspect = sourceWidth / sourceHeight;
          let sx = 0;
          let sy = 0;
          let sw = sourceWidth;
          let sh = sourceHeight;
          if (sourceAspect < targetAspect) {
            sh = sourceWidth / targetAspect;
            sy = Math.max(0, (sourceHeight - sh) * 0.34);
          } else if (sourceAspect > targetAspect) {
            sw = sourceHeight * targetAspect;
            sx = Math.max(0, (sourceWidth - sw) / 2);
          }
          context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          frames.push(canvas.toDataURL('image/jpeg', 0.68));
        }

        if (!cancelled) setTimelineFilmstrip({ key: timelineFilmstripKey, frames, captureFailed: false });
      } catch {
        if (!cancelled) setTimelineFilmstrip({ key: timelineFilmstripKey, frames: [], captureFailed: true });
      } finally {
        video.removeAttribute('src');
        video.load();
      }
    })();

    return () => {
      cancelled = true;
      video.removeAttribute('src');
      video.load();
    };
  }, [previewUrl, timelineFilmstripKey, timelineSampleTimes]);

  function patchSettings(patch: Partial<ClipEditSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function patchTimes(start: number, end: number) {
    if (!settings) return;
    const editableBounds = editableClipBoundsRef.current ?? {
      id: 'editable-clip-bounds',
      start: settings.clip_start_seconds,
      end: settings.clip_end_seconds,
    };
    const minimumDuration = Math.min(3, Math.max(0.1, editableBounds.end - editableBounds.start));
    const safeStart = clamp(start, editableBounds.start, Math.max(editableBounds.start, settings.clip_end_seconds - minimumDuration));
    const safeEnd = clamp(end, safeStart + minimumDuration, editableBounds.end);
    patchSettings({
      clip_start_seconds: safeStart,
      clip_end_seconds: safeEnd,
      cut_points: settings.cut_points.filter((point) => point > safeStart + 0.1 && point < safeEnd - 0.1),
      removed_ranges: settings.removed_ranges
        .map((range) => ({ start: Math.max(range.start, safeStart), end: Math.min(range.end, safeEnd) }))
        .filter((range) => range.end - range.start >= 0.15),
    });
    if (currentTime < safeStart) {
      seekAbsolute(safeStart);
    } else if (currentTime >= safeEnd) {
      videoRef.current?.pause();
      seekAbsolute(safeEnd);
      setPaused(true);
    }
  }

  function splitAtPlayhead() {
    if (!settings) return;
    const point = clamp(currentTime, settings.clip_start_seconds, settings.clip_end_seconds);
    if (point <= settings.clip_start_seconds + 0.15 || point >= settings.clip_end_seconds - 0.15) {
      setToast('Move the playhead inside the clip to split');
      return;
    }
    if (settings.cut_points.some((existing) => Math.abs(existing - point) < 0.15)) {
      setToast('There is already a split here');
      return;
    }
    patchSettings({ cut_points: [...settings.cut_points, Number(point.toFixed(3))].sort((a, b) => a - b) });
    setSelectedRange(null);
    setActiveTool('trim');
    setToast(`Split at ${formatClock(point - settings.clip_start_seconds)}`);
  }

  function deleteLeftOfPlayhead() {
    if (!settings) return;
    const point = clamp(currentTime, settings.clip_start_seconds, settings.clip_end_seconds);
    if (point <= settings.clip_start_seconds + 0.15) {
      setToast('Move the playhead right to delete the left side');
      return;
    }
    patchTimes(point, settings.clip_end_seconds);
    setSelectedRange(null);
    setActiveTool('trim');
    setToast('Deleted everything left of the playhead');
  }

  function deleteRightOfPlayhead() {
    if (!settings) return;
    const point = clamp(currentTime, settings.clip_start_seconds, settings.clip_end_seconds);
    if (point >= settings.clip_end_seconds - 0.15) {
      setToast('Move the playhead left to delete the right side');
      return;
    }
    patchTimes(settings.clip_start_seconds, point);
    setSelectedRange(null);
    setActiveTool('trim');
    setToast('Deleted everything right of the playhead');
  }

  function beginCropDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!settings || activeTool !== 'crop') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      cropX: settings.crop_x,
      cropY: settings.crop_y,
    };
    setCropDragging(true);
    if (settings.framing_mode !== 'manual') patchSettings({ framing_mode: 'manual' });
  }

  function moveCrop(event: ReactPointerEvent<HTMLDivElement>) {
    const origin = cropDragRef.current;
    if (!origin || !settings || activeTool !== 'crop') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const sensitivity = 1 / Math.max(1, settings.zoom);
    patchSettings({
      framing_mode: 'manual',
      crop_x: clamp(origin.cropX - ((event.clientX - origin.clientX) / Math.max(1, rect.width)) * sensitivity, 0, 1),
      crop_y: clamp(origin.cropY - ((event.clientY - origin.clientY) / Math.max(1, rect.height)) * sensitivity, 0, 1),
    });
  }

  function endCropDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!cropDragRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    cropDragRef.current = null;
    setCropDragging(false);
  }

  function resetCrop() {
    patchSettings({ framing_mode: 'manual', crop_x: 0.5, crop_y: 0.34, zoom: 1 });
    setToast('Crop reset');
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

  function selectTimelineChunk(chunk: TranscriptChunk) {
    if (!settings) return;
    const start = clamp(chunk.start, settings.clip_start_seconds, settings.clip_end_seconds);
    const end = clamp(chunk.end, start, settings.clip_end_seconds);
    if (end - start < 0.15) return;
    setSelectedRange({ id: chunk.id, start, end });
    seekAbsolute(start);
    setToast('Segment selected — drag either edge to adjust it');
  }

  function selectTimelineSegment(range: TimelineRange) {
    if (!settings) return;
    const start = clamp(range.start, settings.clip_start_seconds, settings.clip_end_seconds);
    const end = clamp(range.end, start, settings.clip_end_seconds);
    if (end - start < 0.15) return;
    setSelectedRange({ ...range, start, end });
    seekAbsolute(start);
    setToast('Segment selected — adjust its edges or press Delete segment');
  }

  function restoreRemovedRange(index: number) {
    if (!settings) return;
    const restored = settings.removed_ranges[index];
    if (!restored) return;
    const remainingRanges = settings.removed_ranges.filter((_, rangeIndex) => rangeIndex !== index);
    patchSettings({
      removed_ranges: remainingRanges,
      edited_transcript: settings.edited_transcript.map((phrase) => {
        if (!(phrase.end > restored.start && phrase.start < restored.end)) return phrase;
        const stillRemoved = remainingRanges.some((range) => phrase.start >= range.start && phrase.end <= range.end);
        return { ...phrase, deleted: stillRemoved };
      }),
    });
    setToast('Cut restored');
  }

  function selectCaptionPreset(preset: CaptionPreset) {
    if (!settings) return;
    const nextSettings: ClipEditSettings = {
      ...settings,
      caption_preset_id: DEFAULT_CAPTION_PRESET_ID,
      caption_font_size: 12,
      caption_text_color: '#FFFFFF',
      caption_highlight_color: preset.captionHighlightColor,
      caption_background: false,
      caption_word_highlight: true,
      caption_max_words: 2,
      caption_position: 'lower-third',
    };
    setSettings(nextSettings);
    setToast('Caption color preview updated');
  }

  useEffect(() => {
    if (!settings?.removed_ranges.length) return;
    const removed = settings.removed_ranges.find((range) => currentTime >= range.start && currentTime < range.end);
    if (removed) seekAbsolute(removed.end);
  }, [currentTime, settings?.removed_ranges]);

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
    if (settings && currentTime >= settings.clip_end_seconds - 0.05) {
      seekAbsolute(settings.clip_start_seconds);
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

  useEffect(() => {
    function handleEditorShortcut(event: KeyboardEvent) {
      if (event.code !== 'Space' || event.repeat) return;

      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLButtonElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return;

      event.preventDefault();
      void togglePlay();
    }

    window.addEventListener('keydown', handleEditorShortcut);
    return () => window.removeEventListener('keydown', handleEditorShortcut);
  });

  function handlePreviewVolume(nextVolume: number) {
    const safeVolume = clamp(nextVolume, 0, 2);
    patchSettings({ volume: safeVolume });
    if (!videoRef.current) return;
    videoRef.current.muted = safeVolume === 0;
    videoRef.current.volume = Math.min(1, safeVolume);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !settings) return;
    video.muted = settings.volume === 0;
    video.volume = Math.min(1, settings.volume);
  }, [settings?.volume]);

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
      void fetch(`/api/jobs/process?exportId=${encodeURIComponent(clipId)}`, { method: 'POST', cache: 'no-store' }).catch(() => null);
      router.push(`/dashboard/projects/${projectId}`);
    } catch (err) {
      setRendering(false);
      setError(err instanceof Error ? err.message : 'Could not start render');
    }
  }

  function timelineSeconds(event: PointerEvent | ReactPointerEvent<HTMLElement>) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const duration = Math.max(0.1, timelineViewport.end - timelineViewport.start);
    return timelineViewport.start + (x / rect.width) * duration;
  }

  function beginTimelineDrag(mode: DragMode, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragMode(mode);
    const seconds = timelineSeconds(event);
    if (mode === 'start' && settings) patchTimes(seconds, settings.clip_end_seconds);
    if (mode === 'end' && settings) patchTimes(settings.clip_start_seconds, seconds);
    if (mode === 'seek') seekAbsolute(Math.min(seconds, editableClipBoundsRef.current?.end ?? sourceDuration));
    if (mode === 'selection-start' && selectedRange) {
      setSelectedRange({ ...selectedRange, start: clamp(seconds, settings?.clip_start_seconds ?? 0, selectedRange.end - 0.15) });
    }
    if (mode === 'selection-end' && selectedRange) {
      setSelectedRange({ ...selectedRange, end: clamp(seconds, selectedRange.start + 0.15, settings?.clip_end_seconds ?? sourceDuration) });
    }
  }

  useEffect(() => {
    if (!dragMode) return;
    const onMove = (event: PointerEvent) => {
      if (!settings) return;
      const seconds = timelineSeconds(event);
      if (dragMode === 'start') patchTimes(seconds, settings.clip_end_seconds);
      if (dragMode === 'end') patchTimes(settings.clip_start_seconds, seconds);
      if (dragMode === 'seek') seekAbsolute(Math.min(seconds, editableClipBoundsRef.current?.end ?? sourceDuration));
      if (dragMode === 'selection-start') {
        setSelectedRange((range) => range ? {
          ...range,
          start: clamp(seconds, settings.clip_start_seconds, range.end - 0.15),
        } : range);
      }
      if (dragMode === 'selection-end') {
        setSelectedRange((range) => range ? {
          ...range,
          end: clamp(seconds, range.start + 0.15, settings.clip_end_seconds),
        } : range);
      }
    };
    const onUp = () => setDragMode(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragMode, settings, timelineViewport]);

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
  const playerCurrent = clamp(currentTime - settings.clip_start_seconds, 0, clipDuration);
  const playerProgressPercent = clipDuration > 0 ? clamp((playerCurrent / clipDuration) * 100, 0, 100) : 0;
  const timelineDuration = Math.max(0.1, timelineViewport.end - timelineViewport.start);
  const playheadLeft = `${clamp(((currentTime - timelineViewport.start) / timelineDuration) * 100, 0, 100)}%`;
  const clipStartLeft = clamp(((settings.clip_start_seconds - timelineViewport.start) / timelineDuration) * 100, 0, 100);
  const clipEndLeft = clamp(((settings.clip_end_seconds - timelineViewport.start) / timelineDuration) * 100, 0, 100);
  const sourceTrackEndLeft = clamp(((editableTimelineEnd - timelineViewport.start) / timelineDuration) * 100, 0, 100);
  const rulerTicks = Array.from({ length: 7 }, (_, index) => ({
    index,
    value: index === 6 ? timelineDuration : (timelineDuration / 6) * index,
    percent: index === 6 ? 100 : ((timelineDuration / 6) * index / timelineDuration) * 100,
  }));
  const audioBars = Array.from({ length: 240 }, (_, index) => {
    const height = 12 + ((index * 17) % 27);
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
                <p className="mt-1 text-sm font-semibold text-white/68">Edit this reel&apos;s caption text.</p>
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
                  checked={!settings.captions_enabled}
                  onChange={(event) => patchSettings({ captions_enabled: !event.target.checked })}
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
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden p-3">
            <div
              className={`group relative aspect-[9/16] h-full max-h-[630px] w-auto max-w-full overflow-hidden rounded-[8px] bg-[#15171c] shadow-[0_24px_90px_rgba(0,0,0,.45)] ring-1 transition ${activeTool === 'crop' ? 'cursor-grab ring-cyan-300/75 active:cursor-grabbing' : 'cursor-pointer ring-white/10 hover:ring-white/22'}`}
              onPointerDown={beginCropDrag}
              onPointerMove={moveCrop}
              onPointerUp={endCropDrag}
              onPointerCancel={endCropDrag}
            >
              {previewUrl ? (
                <video
                  key={previewUrl}
                  ref={videoRef}
                  src={previewUrl}
                  poster={data.clip.posterUrl ?? data.source.posterUrl ?? undefined}
                  disablePictureInPicture
                  playsInline
                  preload="metadata"
                  className="h-full w-full cursor-pointer bg-black transition-transform duration-200"
                  style={cropPreviewStyle(settings)}
                  onClick={() => {
                    if (activeTool !== 'crop' && !cropDragging) void togglePlay();
                  }}
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    setPreviewDurationSeconds(Number.isFinite(video.duration) ? video.duration : 0);
                    video.muted = settings.volume === 0;
                    video.volume = Math.min(1, settings.volume);
                    video.currentTime = previewUsesSource ? settings.clip_start_seconds : 0;
                  }}
                  onTimeUpdate={(event) => {
                    const video = event.currentTarget;
                    const absolute = previewUsesSource ? video.currentTime : settings.clip_start_seconds + video.currentTime;
                    if (absolute >= settings.clip_end_seconds - 0.01) {
                      video.pause();
                      const endTime = settings.clip_end_seconds;
                      const mediaEndTime = previewUsesSource ? endTime : Math.max(0, endTime - settings.clip_start_seconds);
                      if (Math.abs(video.currentTime - mediaEndTime) > 0.02) video.currentTime = mediaEndTime;
                      setCurrentTime(endTime);
                      setPaused(true);
                      return;
                    }
                    setCurrentTime(clamp(absolute, settings.clip_start_seconds, settings.clip_end_seconds));
                  }}
                  onPlay={() => setPaused(false)}
                  onPause={() => setPaused(true)}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-white/45">Preview unavailable</div>
              )}

              {activeTool === 'crop' ? (
                <div className="pointer-events-none absolute inset-0 z-20">
                  <div className="absolute inset-3 border border-white/90 shadow-[0_0_0_999px_rgba(0,0,0,.18)]">
                    <span className="absolute left-1/3 top-0 h-full w-px bg-white/30" />
                    <span className="absolute left-2/3 top-0 h-full w-px bg-white/30" />
                    <span className="absolute left-0 top-1/3 h-px w-full bg-white/30" />
                    <span className="absolute left-0 top-2/3 h-px w-full bg-white/30" />
                    {['left-0 top-0 border-l-2 border-t-2', 'right-0 top-0 border-r-2 border-t-2', 'bottom-0 left-0 border-b-2 border-l-2', 'bottom-0 right-0 border-b-2 border-r-2'].map((position) => (
                      <span key={position} className={`absolute h-5 w-5 border-white ${position}`} />
                    ))}
                  </div>
                  <span className="absolute left-1/2 top-5 -translate-x-1/2 rounded-full bg-black/65 px-3 py-1 text-[10px] font-bold text-white/90 backdrop-blur">
                    Drag video to reframe
                  </span>
                </div>
              ) : null}

              {previewUsesSource && settings.captions_enabled && activeCaptionText ? (
                <div
                  className="pointer-events-none absolute z-20 max-w-[88%] text-center"
                  style={{ left: `${settings.caption_x * 100}%`, top: `${settings.caption_y * 100}%`, transform: 'translate(-50%, -50%)' }}
                >
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

              {paused && activeTool !== 'crop' ? (
                <button
                  type="button"
                  onClick={() => void togglePlay()}
                  className="pointer-events-none absolute left-1/2 top-1/2 z-30 inline-flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/30 text-white opacity-0 backdrop-blur-sm transition duration-200 hover:bg-black/45 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                  aria-label="Play preview"
                >
                  <svg viewBox="0 0 24 24" className="h-7 w-7 fill-current" aria-hidden="true">
                    <path d="M8 5.5v13l10-6.5-10-6.5Z" />
                  </svg>
                </button>
              ) : null}

              {previewUrl && activeTool !== 'crop' ? (
                <div
                  className="absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-3 pt-8"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="relative mb-3 h-[2px] w-full bg-white/25">
                    <div className="h-full bg-white transition-[width] duration-150" style={{ width: `${playerProgressPercent}%` }} />
                    <div
                      className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white"
                      style={{ left: `calc(${playerProgressPercent}% - 6px)` }}
                    />
                    <input
                      type="range"
                      min={settings.clip_start_seconds}
                      max={Math.max(settings.clip_start_seconds + 0.01, settings.clip_end_seconds)}
                      step="0.01"
                      value={clamp(currentTime, settings.clip_start_seconds, settings.clip_end_seconds)}
                      onChange={(event) => seekAbsolute(Number(event.target.value))}
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
                        value={Math.min(1, settings.volume)}
                        onChange={(event) => handlePreviewVolume(Number(event.target.value))}
                        className="h-1.5 w-16 cursor-pointer accent-white"
                        aria-label="Clip volume"
                      />
                    </div>
                    <span className="ml-auto shrink-0 rounded-full border border-white/15 bg-black/35 px-2.5 py-1 text-[11px] text-white/85 tabular-nums backdrop-blur-sm">
                      {formatClock(playerCurrent)} / {formatClock(clipDuration)}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-white/[0.035] bg-[#111318]/95">
          <div className="border-b border-white/10 px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-cyan-300">{activeTool}</p>
            <p className="mt-1 text-sm font-semibold text-white">
              {activeTool === 'crop' ? 'Reframe video' : activeTool === 'trim' ? 'Clip timing' : activeTool === 'audio' ? 'Clip audio' : 'Caption style'}
            </p>
          </div>

          <div className="min-h-0 space-y-4 overflow-y-auto p-4">
            {activeTool === 'crop' ? (
              <div className="space-y-5">
                <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/[0.06] p-3 text-xs font-semibold leading-5 text-cyan-50/75">
                  Drag the video in the player to position it inside the vertical frame.
                </div>
                <label className="block space-y-2">
                  <span className="flex items-center justify-between text-xs font-bold text-white/70">
                    Zoom <span className="font-mono text-white">{settings.zoom.toFixed(2)}x</span>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={2.4}
                    step={0.01}
                    value={settings.zoom}
                    onChange={(event) => patchSettings({ framing_mode: 'manual', zoom: Number(event.target.value) })}
                    className="w-full cursor-pointer accent-cyan-300"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => patchSettings({ framing_mode: 'fit', zoom: 1 })} className="rounded-lg border border-white/10 px-3 py-2.5 text-xs font-bold text-white/70 hover:bg-white/[0.06]">Fit</button>
                  <button type="button" onClick={resetCrop} className="rounded-lg border border-white/10 px-3 py-2.5 text-xs font-bold text-white/70 hover:bg-white/[0.06]">Reset crop</button>
                </div>
              </div>
            ) : activeTool === 'trim' ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-white/10 bg-white/[0.035] p-4">
                  <p className="text-xs font-bold text-white/45">Clip duration</p>
                  <p className="mt-1 font-mono text-2xl font-black text-white">{formatClock(clipDuration)}</p>
                  <p className="mt-2 text-xs font-semibold leading-5 text-white/48">Hover over either clip edge, then drag inward to shorten or outward to restore footage.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-lg bg-black/25 px-3 py-2"><p className="text-[10px] font-bold uppercase text-white/35">Start</p><p className="font-mono text-sm text-white">0:00</p></div>
                  <div className="rounded-lg bg-black/25 px-3 py-2"><p className="text-[10px] font-bold uppercase text-white/35">End</p><p className="font-mono text-sm text-white">{formatClock(clipDuration)}</p></div>
                </div>
              </div>
            ) : activeTool === 'audio' ? (
              <div className="space-y-5">
                <div className="rounded-xl border border-white/10 bg-white/[0.035] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-black text-white">Volume</p>
                    <span className="font-mono text-sm font-bold text-cyan-200">{Math.round(settings.volume * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={settings.volume}
                    onChange={(event) => handlePreviewVolume(Number(event.target.value))}
                    className="mt-4 w-full cursor-pointer accent-cyan-300"
                    aria-label="Export volume"
                  />
                  <div className="mt-2 flex justify-between text-[10px] font-bold text-white/35"><span>Mute</span><span>100%</span><span>200%</span></div>
                </div>
              </div>
            ) : (
            <div className="space-y-4">
              <div className="-mx-4 -mt-4 border-b border-white/10 bg-[#26282c] px-3 pt-1">
                <div className="flex items-center gap-1">
                  <button type="button" className="border-b-2 border-cyan-300 px-3 py-3 text-xs font-bold text-cyan-300">Basic</button>
                  <button type="button" className="px-3 py-3 text-xs font-bold text-white/45" title="More caption animations coming soon">Animation</button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-sm font-black text-white">Captions</p>
                <label className="flex items-center gap-2 text-xs font-bold text-white/58">
                  <input type="checkbox" checked={settings.captions_enabled} onChange={(event) => patchSettings({ captions_enabled: event.target.checked })} className="accent-emerald-400" />
                  On
                </label>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-black text-white/70">Highlight color</p>
                <div className="flex flex-wrap gap-2">
                  {presetOptions.map((preset) => {
                    const selected =
                      preset.captionHighlightColor.toLowerCase() ===
                      settings.caption_highlight_color.toLowerCase();
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => selectCaptionPreset(preset)}
                        className={`h-9 w-9 rounded-full border-2 transition hover:scale-105 ${
                          selected
                            ? 'border-white ring-2 ring-cyan-300/70 ring-offset-2 ring-offset-[#111318]'
                            : 'border-white/20'
                        }`}
                        style={{ backgroundColor: preset.captionHighlightColor }}
                        aria-label={`Use ${preset.name} highlight color`}
                        title={preset.name}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="border-t border-white/10 pt-4">
                <div className="mb-4 flex items-center justify-between">
                  <p className="text-xs font-black text-white/80">Transform</p>
                  <button
                    type="button"
                    onClick={() => patchSettings({ caption_position: 'lower-third', caption_x: 0.5, caption_y: 0.8, caption_font_size: activePreset?.captionFontSize ?? 11 })}
                    className="rounded-md px-2 py-1 text-lg leading-none text-white/45 transition hover:bg-white/[0.06] hover:text-white"
                    title="Reset caption transform"
                    aria-label="Reset caption transform"
                  >↶</button>
                </div>

                <label className="block space-y-2">
                  <span className="flex items-center justify-between text-xs font-semibold text-white/70">
                    Scale
                    <span className="rounded-md bg-black/30 px-2 py-1 font-mono text-white/85">{Math.round((settings.caption_font_size / 11) * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min={6}
                    max={20}
                    step={0.5}
                    value={settings.caption_font_size}
                    onChange={(event) => patchSettings({ caption_font_size: Number(event.target.value) })}
                    className="w-full cursor-pointer accent-cyan-300"
                    aria-label="Caption scale"
                  />
                </label>

                <div className="mt-5 space-y-2">
                  <p className="text-xs font-semibold text-white/70">Position</p>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex items-center rounded-md bg-black/25 px-2 text-[10px] font-bold text-white/35">
                      X
                      <input
                        type="number"
                        min={8}
                        max={92}
                        value={Math.round(settings.caption_x * 100)}
                        onChange={(event) => patchSettings({ caption_x: clamp(Number(event.target.value) / 100, 0.08, 0.92) })}
                        className="min-w-0 flex-1 bg-transparent px-2 py-2 text-right font-mono text-xs text-white outline-none"
                        aria-label="Caption horizontal position"
                      />
                    </label>
                    <label className="flex items-center rounded-md bg-black/25 px-2 text-[10px] font-bold text-white/35">
                      Y
                      <input
                        type="number"
                        min={8}
                        max={92}
                        value={Math.round(settings.caption_y * 100)}
                        onChange={(event) => patchSettings({ caption_y: clamp(Number(event.target.value) / 100, 0.08, 0.92) })}
                        className="min-w-0 flex-1 bg-transparent px-2 py-2 text-right font-mono text-xs text-white outline-none"
                        aria-label="Caption vertical position"
                      />
                    </label>
                  </div>
                  <p className="text-[10px] font-semibold text-white/35">You can also drag captions directly on the video.</p>
                </div>

                <div className="mt-5 space-y-2">
                  <p className="text-xs font-semibold text-white/70">Quick align</p>
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/25 p-1.5">
                  {([['upper', 'Top'], ['center', 'Center'], ['lower-third', 'Bottom']] as const).map(([position, label]) => (
                    <button
                      key={position}
                      type="button"
                      onClick={() => patchSettings({
                        caption_position: position,
                        caption_x: 0.5,
                        caption_y: position === 'upper' ? 0.18 : position === 'center' ? 0.5 : 0.8,
                      })}
                      className={`rounded-md px-2 py-2 text-[11px] font-bold transition ${settings.caption_position === position ? 'bg-white/15 text-white' : 'text-white/48 hover:bg-white/[0.06] hover:text-white'}`}
                    >
                      {label}
                    </button>
                  ))}
                  </div>
                </div>
              </div>
            </div>
            )}

          </div>
        </aside>
      </section>

      <section className="mx-auto mt-3 w-full max-w-[1360px] overflow-hidden rounded-[12px] border border-white/[0.035] bg-[#111318]/95">
        <div className="flex items-center gap-1 border-b border-white/[0.08] bg-[#1b1d21] px-3 py-2">
          {([
            ['trim', 'Trim', 'M6 7h12M8 4v6m8-6v6M7 14h10v5H7z'],
            ['crop', 'Crop', 'M4 4v12a4 4 0 0 0 4 4h12M8 4v12h12'],
            ['captions', 'Captions', 'M4 6h16v12H4zM7 10h4m2 0h4m-10 4h3m2 0h5'],
            ['audio', 'Audio', 'M4 10v4h4l5 4V6L8 10H4zm12-1a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12'],
          ] as const).map(([tool, label, path]) => (
            <button
              key={tool}
              type="button"
              onClick={() => setActiveTool(tool)}
              className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-xs font-bold transition ${activeTool === tool ? 'bg-white text-black' : 'text-white/60 hover:bg-white/[0.07] hover:text-white'}`}
              aria-pressed={activeTool === tool}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
              {label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-white/10" />
          {([
            ['Split', splitAtPlayhead, 'M8 4v6m0 4v6M16 4v6m0 4v6M5 12h14'],
            ['Delete left', deleteLeftOfPlayhead, 'M8 4v16M17 5v14M5 12h9m-3-3 3 3-3 3'],
            ['Delete right', deleteRightOfPlayhead, 'M16 4v16M7 5v14m3-7h9m-3-3 3 3-3 3'],
          ] as const).map(([label, action, path]) => (
            <button
              key={label}
              type="button"
              onClick={action}
              className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-xs font-bold text-white/60 transition hover:bg-white/[0.07] hover:text-white"
              title={`${label} at playhead`}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
              {label}
            </button>
          ))}
          <span className="mx-2 h-5 w-px bg-white/10" />
          <button
            type="button"
            onClick={() => {
              setSettings(JSON.parse(baseline) as ClipEditSettings);
              setSelectedRange(null);
              setToast('Changes reset');
            }}
            disabled={!changed}
            className="rounded-md px-3 py-2 text-xs font-bold text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-30"
          >
            Undo changes
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] px-3 py-2">
          <div>
            <p className="text-sm font-black text-white">Timeline</p>
            <p className="text-xs font-semibold text-white/45">
              Reel 0:00 - {formatClock(clipDuration)} · {timelineSegments.length} {timelineSegments.length === 1 ? 'segment' : 'segments'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs font-bold ${changed ? 'text-amber-200/80' : 'text-white/45'}`}>
              {changed ? 'Unsaved draft — Apply to save and render' : 'No unsaved changes'}
            </span>
            <button onClick={() => void rerenderClip()} disabled={!needsRender || rendering} className="rounded-full bg-white px-5 py-2 text-sm font-black text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-45">
              {rendering ? 'Applying...' : 'Apply'}
            </button>
          </div>
        </div>

        <div className="px-3 py-2">
          <p className="mb-2 text-xs font-semibold text-white/48">
            Hover over a clip edge and drag it to set the exact start or end. The preview and final render use the selected range.
          </p>
          <div className="relative grid h-[176px] grid-cols-[54px_1fr] overflow-hidden rounded-2xl border border-white/10 bg-black/35">
            <div className="border-r border-white/[0.08] bg-black/25 text-[10px] font-black uppercase tracking-[0.12em] text-white/36">
              <div className="grid h-[31px] place-items-center border-b border-white/[0.08] bg-white/[0.02]">
                <button
                  type="button"
                  onClick={() => void togglePlay()}
                  disabled={!previewUrl}
                  className="grid h-7 w-7 place-items-center rounded-full border border-white/15 bg-white/[0.06] text-white/85 transition hover:border-white/30 hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-35"
                  aria-label={paused ? 'Play timeline preview' : 'Pause timeline preview'}
                  title={paused ? 'Play timeline' : 'Pause timeline'}
                >
                  {paused ? (
                    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
                      <path d="M8 5.5v13l10-6.5-10-6.5Z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
                      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                    </svg>
                  )}
                </button>
              </div>
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
              className="group/timeline relative overflow-hidden"
              style={{ cursor: 'pointer' }}
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
              {timelineChunks.map((chunk) => {
                const start = clamp(chunk.start - timelineViewport.start, 0, timelineDuration);
                const end = clamp(chunk.end - timelineViewport.start, 0, timelineDuration);
                const selected = selectedRange?.id === chunk.id;
                return (
                  <button
                    type="button"
                    key={chunk.id}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      selectTimelineChunk(chunk);
                    }}
                    className={`absolute top-[38px] z-10 h-[22px] overflow-hidden rounded-[4px] px-2 text-left text-[9px] font-black leading-[22px] text-black/78 ${selected ? 'bg-orange-100 ring-2 ring-white' : 'bg-orange-300/80'}`}
                    title={chunk.text}
                    style={{
                      left: `${(start / timelineDuration) * 100}%`,
                      width: `${Math.max(0.45, ((end - start) / timelineDuration) * 100)}%`,
                      cursor: 'pointer',
                    }}
                  >
                    {chunk.text}
                  </button>
                );
              })}

              <div className="absolute left-0 top-[69px] h-[58px] bg-cyan-300/10" style={{ width: `${sourceTrackEndLeft}%` }} />
              <div className="absolute left-0 top-[72px] flex h-[52px] overflow-hidden border-y border-cyan-100/15 bg-cyan-950/70" style={{ width: `${sourceTrackEndLeft}%` }}>
                {timelineFilmstrip.key === timelineFilmstripKey && timelineFilmstrip.frames.length === timelineSampleTimes.length
                  ? timelineFilmstrip.frames.map((frame, index) => (
                    <span
                      key={`${timelineFilmstripKey}-${index}`}
                      className="h-full min-w-0 flex-1 border-r border-black/20 bg-cover bg-center last:border-r-0"
                      style={{ backgroundImage: `url("${frame}")` }}
                      aria-hidden="true"
                    />
                  ))
                  : timelineFilmstrip.key === timelineFilmstripKey && timelineFilmstrip.captureFailed && previewUrl
                    ? timelineSampleTimes.map((time, index) => (
                      <TimelineVideoThumbnail key={`${timelineFilmstripKey}-video-${index}`} src={previewUrl} time={time} />
                    ))
                    : timelineSampleTimes.map((_, index) => (
                      <span
                        key={`${timelineFilmstripKey}-loading-${index}`}
                        className="h-full min-w-0 flex-1 animate-pulse border-r border-white/5 bg-cyan-200/10 last:border-r-0"
                        aria-hidden="true"
                      />
                    ))}
              </div>

              <div
                className="pointer-events-none absolute bottom-0 top-[31px] z-[14] bg-black/60"
                style={{ left: 0, width: `${clipStartLeft}%` }}
              />
              <div
                className="pointer-events-none absolute bottom-0 top-[31px] z-[14] bg-black/60"
                style={{ left: `${clipEndLeft}%`, right: 0 }}
              />
              <div
                className="pointer-events-none absolute bottom-0 top-[31px] z-[16] border-y-2 border-cyan-300/85 bg-cyan-300/[0.035]"
                style={{ left: `${clipStartLeft}%`, width: `${Math.max(0, clipEndLeft - clipStartLeft)}%` }}
              />

              {activeTool === 'trim' ? timelineSegments.map((segment, index) => (
                <button
                  type="button"
                  key={segment.id}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectTimelineSegment(segment);
                  }}
                  className={`absolute bottom-0 top-[69px] z-[15] border-x transition ${
                    selectedRange?.id === segment.id
                      ? 'border-orange-100 bg-orange-300/12'
                      : index % 2 === 0
                        ? 'border-cyan-100/30 bg-white/[0.015] hover:bg-white/[0.035]'
                        : 'border-cyan-100/30 bg-cyan-200/[0.025] hover:bg-white/[0.035]'
                  }`}
                  style={{
                    left: `${clamp(((segment.start - timelineViewport.start) / timelineDuration) * 100, 0, 100)}%`,
                    width: `${clamp(((segment.end - segment.start) / timelineDuration) * 100, 0, 100)}%`,
                    cursor: 'pointer',
                  }}
                  aria-label={`Select segment ${index + 1}`}
                  title={`Segment ${index + 1}: ${formatClock(segment.end - segment.start)}`}
                />
              )) : null}
              <div className="absolute bottom-2 left-0 flex h-7 items-end justify-between gap-px px-1.5" style={{ width: `${sourceTrackEndLeft}%` }}>
                {audioBars.map((height, index) => (
                  <span
                    key={index}
                    className="w-px min-w-px rounded-t-sm bg-sky-300/55"
                    style={{ height: `${height}%` }}
                  />
                ))}
              </div>
              {settings.removed_ranges.map((range, index) => (
                <button
                  type="button"
                  key={`${range.start}-${range.end}-${index}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => restoreRemovedRange(index)}
                  className="absolute bottom-0 top-[31px] z-20 border-x border-red-300/70 bg-red-500/25 transition hover:bg-red-400/35"
                  style={{
                    left: `${clamp(((range.start - timelineViewport.start) / timelineDuration) * 100, 0, 100)}%`,
                    width: `${clamp(((range.end - range.start) / timelineDuration) * 100, 0, 100)}%`,
                  }}
                  aria-label="Restore removed range"
                  title="Click to restore this cut"
                />
              ))}

              {selectedRange ? (
                <div
                  className="pointer-events-none absolute bottom-0 top-[31px] z-30 border-y border-orange-200/90 bg-orange-300/18"
                  style={{
                    left: `${clamp(((selectedRange.start - timelineViewport.start) / timelineDuration) * 100, 0, 100)}%`,
                    width: `${clamp(((selectedRange.end - selectedRange.start) / timelineDuration) * 100, 0, 100)}%`,
                  }}
                >
                  <span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[9px] font-bold text-orange-100">
                    {formatClock(selectedRange.end - selectedRange.start)} selected · Delete/Backspace to remove
                  </span>
                </div>
              ) : null}

              {selectedRange ? (
                <>
                  <button
                    type="button"
                    onPointerDown={(event) => beginTimelineDrag('selection-start', event)}
                    className="absolute bottom-0 top-[31px] z-40 w-3 -translate-x-1/2 cursor-ew-resize bg-orange-200 shadow-[0_0_12px_rgba(253,186,116,.7)]"
                    style={{ left: `${clamp(((selectedRange.start - timelineViewport.start) / timelineDuration) * 100, 0, 100)}%` }}
                    aria-label="Adjust selected segment start"
                  />
                  <button
                    type="button"
                    onPointerDown={(event) => beginTimelineDrag('selection-end', event)}
                    className="absolute bottom-0 top-[31px] z-40 w-3 -translate-x-1/2 cursor-ew-resize bg-orange-200 shadow-[0_0_12px_rgba(253,186,116,.7)]"
                    style={{ left: `${clamp(((selectedRange.end - timelineViewport.start) / timelineDuration) * 100, 0, 100)}%` }}
                    aria-label="Adjust selected segment end"
                  />
                </>
              ) : null}

              <div
                className={`pointer-events-none absolute inset-y-0 z-30 w-px bg-white/90 shadow-[0_0_10px_rgba(255,255,255,.45)] transition-opacity ${dragMode === 'seek' || !paused ? 'opacity-100' : 'opacity-0 group-hover/timeline:opacity-100'}`}
                style={{ left: playheadLeft }}
              />
              <button
                onPointerDown={(event) => beginTimelineDrag('start', event)}
                className={`absolute top-[31px] z-40 h-[145px] w-5 -translate-x-1/2 cursor-ew-resize transition-opacity ${dragMode === 'start' ? 'opacity-100' : 'opacity-0 group-hover/timeline:opacity-100'}`}
                style={{ left: `${clipStartLeft}%` }}
                aria-label="Trim start"
              >
                <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/90" />
                <span className="absolute left-1/2 top-1/2 flex h-11 w-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded bg-white text-black shadow-lg"><i className="h-4 w-px bg-black/35" /></span>
              </button>
              <button
                onPointerDown={(event) => beginTimelineDrag('end', event)}
                className={`absolute top-[31px] z-40 h-[145px] w-5 -translate-x-1/2 cursor-ew-resize transition-opacity ${dragMode === 'end' ? 'opacity-100' : 'opacity-0 group-hover/timeline:opacity-100'}`}
                style={{ left: `${clipEndLeft}%` }}
                aria-label="Trim end"
              >
                <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/90" />
                <span className="absolute left-1/2 top-1/2 flex h-11 w-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded bg-white text-black shadow-lg"><i className="h-4 w-px bg-black/35" /></span>
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
