'use client';

import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CAPTION_PRESETS, DEFAULT_CAPTION_PRESET_ID } from '@/lib/caption-presets';
import type { ClipEditSettings } from '@/lib/clip-edit';
import { readJsonSafe } from '@/lib/safe-json';

type ClipItem = {
  exportId: string;
  clipCandidateId: string | null;
  title: string;
  score: number;
  status: string;
  errorMessage: string | null;
  signedUrl: string | null;
  posterUrl?: string | null;
  startSec: number | null;
  endSec: number | null;
  reason?: string | null;
  rank: number | null;
  captionPresetId?: string | null;
  captionsEnabled?: boolean;
  captionHighlightColor?: string | null;
  editStatus?: string | null;
  editStartedAt?: string | null;
};

const CAPTION_TEMPLATE_OPTIONS = [
  ...CAPTION_PRESETS.filter((preset) => preset.id === DEFAULT_CAPTION_PRESET_ID),
  ...CAPTION_PRESETS.filter((preset) => preset.id !== DEFAULT_CAPTION_PRESET_ID),
].slice(0, 9);

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

function addUniqueTag(tags: string[], label: string) {
  if (!tags.includes(label)) tags.push(label);
}

function getSmartClipTags(clip: ClipItem) {
  const title = `${clip.title} ${clip.reason ?? ''}`.toLowerCase();
  const score = toDisplayScore(clip.score);

  if (
    /\?|\b(why|how|what|when|where|who|can you|do you|did you)\b/i.test(clip.title) ||
    /\b(first|opening|start|intro|begins|hook|wait|listen|watch this)\b/i.test(title)
  ) {
    return ['⚡ Strong Hook'];
  }
  if (/\b(story|journey|moment|reveal|remember|memory|confession|truth|chapter|timeline|started|ended|realized)\b/i.test(title)) return ['📖 Story'];
  if (score >= 96) return ['🔥 Viral'];
  if (/\b(crazy|wild|intense|shocking|reaction|reacts|wow|heated|explodes|energy)\b/i.test(title)) return ['⚡ High Energy'];
  if (/\b(fight|knockout|ufc|boxing|rematch|challenge|beating|beat|loss|win)\b/i.test(title)) return ['🥊 Fight Talk'];
  if (/\b(funny|laugh|comedy|joke|hilarious)\b/i.test(title)) return ['😂 Funny'];
  if (/\b(emotional|daughter|family|lost|broke|heart|honest)\b/i.test(title)) return ['❤️ Emotional'];
  if (/\b(learn|explain|tips|strategy|lesson|breakdown|because|reason)\b/i.test(title)) return ['💡 Insight'];

  if (score >= 92) return ['📈 High Retention'];
  if (score >= 86) return ['✅ Strong Clip'];
  if (score >= 78) return ['👍 Good Clip'];
  return ['🔎 Review'];
}

function getPrimaryClipBadge(clip: ClipItem) {
  const title = `${clip.title} ${clip.reason ?? ''}`.toLowerCase();
  const score = toDisplayScore(clip.score);

  if (/\b(story|journey|moment|reveal|remember|memory|confession|truth|chapter|timeline|started|ended|realized|honest)\b/i.test(title)) return '📖 Story';
  if (score >= 96) return '🔥 Viral';
  if (
    /\?|\b(why|how|what|when|where|who|can you|do you|did you)\b/i.test(clip.title) ||
    /\b(first|opening|start|intro|begins|hook|wait|listen|watch this)\b/i.test(title)
  ) return '⚡ Strong Hook';
  if (/\b(crazy|wild|intense|shocking|reaction|reacts|wow|heated|explodes|energy)\b/i.test(title)) return '⚡ High Energy';
  if (/\b(fight|knockout|ufc|boxing|rematch|challenge|beating|beat|loss|win)\b/i.test(title)) return '🥊 Fight Talk';
  if (/\b(funny|laugh|comedy|joke|hilarious)\b/i.test(title)) return '😂 Funny';
  if (/\b(emotional|daughter|family|lost|broke|heart)\b/i.test(title)) return '❤️ Emotional';
  if (/\b(learn|explain|tips|strategy|lesson|breakdown|because|reason)\b/i.test(title)) return '💡 Insight';
  if (score >= 92) return '📈 Retention';
  if (score >= 86) return '✅ Strong Clip';
  if (score >= 78) return '👍 Good Clip';
  return '🔎 Review';
}

function getPreviewCaptionWords(title: string) {
  const words = title
    .replace(/[|:]+/g, ' ')
    .split(/\s+/)
    .filter((word) => /^[a-z0-9'?-]+$/i.test(word))
    .slice(0, 4)
    .map((word) => word.replace(/[^\w'?-]/g, '').toUpperCase());

  if (words.length >= 2) return { highlight: words[0], rest: words.slice(1, 3).join(' ') };
  return { highlight: 'THE', rest: 'MOMENT' };
}

function getPresetCaptionStyle(preset: (typeof CAPTION_PRESETS)[number], size: 'tile' | 'reel'): CSSProperties {
  const scale = size === 'reel' ? 2.25 : 1.65;
  const stroke = Math.max(0, Math.round(preset.captionStrokeWidth * (size === 'reel' ? 0.78 : 0.42)));
  const glowColor = preset.captionHighlightColor;
  const shadowMap: Record<string, string> = {
    'black-heavy': `0 ${3 * scale}px 0 #000, 0 ${5 * scale}px ${8 * scale}px rgba(0,0,0,.85)`,
    'heavy-shadow': `0 ${3 * scale}px 0 #000, 0 ${6 * scale}px ${10 * scale}px rgba(0,0,0,.78)`,
    'clean-shadow': `0 ${2 * scale}px ${5 * scale}px rgba(0,0,0,.78)`,
    'subtle-shadow': `0 ${1.5 * scale}px ${4 * scale}px rgba(0,0,0,.6)`,
    'neon-glow': `0 0 ${7 * scale}px ${glowColor}, 0 ${2 * scale}px ${8 * scale}px rgba(0,0,0,.85)`,
    'purple-glow': `0 0 ${7 * scale}px #8b5cf6, 0 0 ${12 * scale}px ${glowColor}, 0 ${2 * scale}px ${8 * scale}px rgba(0,0,0,.85)`,
    'yellow-glow': `0 ${3 * scale}px 0 #000, 0 0 ${7 * scale}px rgba(250,204,21,.75), 0 ${5 * scale}px ${8 * scale}px rgba(0,0,0,.85)`,
    'soft-glow': `0 0 ${5 * scale}px ${glowColor}, 0 ${3 * scale}px ${8 * scale}px rgba(0,0,0,.8)`,
    'red-pop': `0 ${3 * scale}px 0 #000, ${2 * scale}px ${4 * scale}px 0 rgba(255,59,48,.7), 0 ${6 * scale}px ${9 * scale}px rgba(0,0,0,.85)`,
    'bubble-shadow': `0 ${2 * scale}px ${6 * scale}px rgba(0,0,0,.3)`,
  };

  return {
    color: preset.captionTextColor,
    fontFamily: preset.captionFontFamily,
    fontSize: `${Math.round(preset.captionFontSize * scale)}px`,
    fontWeight: 950,
    letterSpacing: 0,
    lineHeight: 1,
    textTransform: 'uppercase',
    WebkitTextStroke: stroke > 0 ? `${stroke}px ${preset.captionStrokeColor}` : '0px transparent',
    textShadow: shadowMap[preset.captionShadow] ?? shadowMap['black-heavy'],
  };
}

function CaptionPreviewText({
  preset,
  title,
  size = 'tile',
}: {
  preset: (typeof CAPTION_PRESETS)[number];
  title: string;
  size?: 'tile' | 'reel';
}) {
  const words = getPreviewCaptionWords(title);
  const baseStyle = getPresetCaptionStyle(preset, size);

  if (preset.captionBackgroundBox) {
    return (
      <span className="inline-block rounded-md bg-white px-2.5 py-1 shadow-[0_4px_18px_rgba(0,0,0,.35)]">
        <span style={{ ...baseStyle, WebkitTextStroke: '0px transparent', textShadow: 'none', color: '#0b0d12' }}>
          {words.highlight} {words.rest}
        </span>
      </span>
    );
  }

  return (
    <span className="inline-block text-center">
      <span style={{ ...baseStyle, color: preset.captionHighlightColor }}>{words.highlight}</span>{' '}
      <span style={baseStyle}>{words.rest}</span>
    </span>
  );
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

function formatEta(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function ReelEditProcessingOverlay({ clip }: { clip: ClipItem }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const startedAt = Date.parse(clip.editStartedAt ?? '');
  const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(0, (now - startedAt) / 1000) : 0;
  const clipSeconds = Math.max(10, Number(clip.endSec ?? 0) - Number(clip.startSec ?? 0));
  const estimatedSeconds = clampNumber(18 + clipSeconds * 1.35, 28, 105);
  const progress = Math.min(96, 8 + 88 * (1 - Math.exp(-elapsedSeconds / Math.max(12, estimatedSeconds * 0.55))));
  const etaSeconds = Math.max(5, estimatedSeconds - elapsedSeconds);

  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#090b10]/88 px-5 text-center backdrop-blur-[2px]">
      <span className="inline-flex h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-emerald-300" aria-hidden="true" />
      <p className="mt-4 text-sm font-black text-white">Applying reel changes</p>
      <p className="mt-1 text-xs font-semibold text-white/58">ETA {formatEta(etaSeconds)}</p>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/12">
        <div
          className="relative h-full overflow-hidden rounded-full bg-emerald-400 transition-[width] duration-700"
          style={{ width: `${progress}%` }}
        >
          <span className="progress-active-sheen absolute inset-y-0 block w-10 bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        </div>
      </div>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-200/75">{Math.round(progress)}% processing</p>
    </div>
  );
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getClipFileName(clip: ClipItem) {
  return `${(clip.title || 'clip')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'clip'}.mp4`;
}

function downloadClipBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export function TopClipsBoard({ projectId, clips }: Props) {
  const router = useRouter();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<Record<string, PlaybackState>>({});
  const [editingClip, setEditingClip] = useState<ClipItem | null>(null);
  const [captionSettings, setCaptionSettings] = useState<ClipEditSettings | null>(null);
  const [captionModalDefaults, setCaptionModalDefaults] = useState({
    presetId: CAPTION_TEMPLATE_OPTIONS[0]?.id ?? DEFAULT_CAPTION_PRESET_ID,
    captionsEnabled: true,
  });
  const [loadingCaptionSettings, setLoadingCaptionSettings] = useState(false);
  const [applyingPreset, setApplyingPreset] = useState(false);
  const [optimisticEditIds, setOptimisticEditIds] = useState<Set<string>>(() => new Set());
  const renderKickInFlightRef = useRef(false);
  const playRequestsRef = useRef<Record<string, number>>({});
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const stableMediaUrlsRef = useRef(new Map<string, string>());
  const previousEditStatusesRef = useRef(new Map<string, string | null | undefined>());
  const refreshMediaOnNextUrlRef = useRef(new Set<string>());

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
      playRequestsRef.current[id] = (playRequestsRef.current[id] ?? 0) + 1;
      video.pause();
      updatePlayback(id, { paused: true });
    }
  }

  function primeVideo(id: string, preload: 'metadata' | 'auto' = 'metadata') {
    const video = videoRefs.current[id];
    if (!video) return;
    if (video.preload !== preload) {
      video.preload = preload;
    }
    if (video.readyState === 0) {
      video.load();
    }
  }

  function isInterruptedPlayError(error: unknown) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error ?? '');
    return name === 'AbortError' || /play\(\) request was interrupted/i.test(message);
  }

  async function playVideo(id: string) {
    const video = videoRefs.current[id];
    if (!video || !video.paused) return;

    const requestId = (playRequestsRef.current[id] ?? 0) + 1;
    playRequestsRef.current[id] = requestId;
    primeVideo(id, 'auto');
    pauseOtherVideos(id);

    try {
      await video.play();
      if (playRequestsRef.current[id] === requestId) {
        updatePlayback(id, { paused: false });
      }
    } catch (error) {
      updatePlayback(id, { paused: video.paused });
      if (!isInterruptedPlayError(error)) {
        console.warn('[clips] video play failed', error);
      }
    }
  }

  function togglePlay(id: string) {
    const video = videoRefs.current[id];
    if (!video) return;

    if (video.paused) {
      void playVideo(id);
      return;
    }

    playRequestsRef.current[id] = (playRequestsRef.current[id] ?? 0) + 1;
    video.pause();
    updatePlayback(id, { paused: true });
  }

  async function openCaptionTemplates(clip: ClipItem) {
    const fallbackPreset = CAPTION_TEMPLATE_OPTIONS.find((preset) =>
      preset.captionHighlightColor.toLowerCase() === clip.captionHighlightColor?.toLowerCase()
    ) ?? CAPTION_TEMPLATE_OPTIONS.find((preset) => preset.id === clip.captionPresetId) ?? CAPTION_TEMPLATE_OPTIONS[0];
    for (const video of Object.values(videoRefs.current)) video?.pause();
    setCaptionModalDefaults({
      presetId: fallbackPreset?.id ?? DEFAULT_CAPTION_PRESET_ID,
      captionsEnabled: clip.captionsEnabled !== false,
    });
    setCaptionSettings(null);
    setEditingClip(clip);
    setLoadingCaptionSettings(true);

    try {
      const res = await fetch(`/api/clips/${clip.exportId}/edit`, { cache: 'no-store' });
      const data = await readJsonSafe(res);
      if (!res.ok || !data?.settings) throw new Error(String(data?.error || 'Could not load caption settings'));
      const settings = data.settings as ClipEditSettings;
      const selected = CAPTION_TEMPLATE_OPTIONS.find((preset) =>
        preset.captionHighlightColor.toLowerCase() === settings.caption_highlight_color.toLowerCase()
      ) ?? fallbackPreset;
      setCaptionSettings(settings);
      setCaptionModalDefaults({
        presetId: selected?.id ?? DEFAULT_CAPTION_PRESET_ID,
        captionsEnabled: settings.captions_enabled,
      });
    } catch (error) {
      setEditingClip(null);
      window.alert(error instanceof Error ? error.message : 'Could not load caption settings');
    } finally {
      setLoadingCaptionSettings(false);
    }
  }

  function openClipEditor(clip: ClipItem) {
    router.push(`/dashboard/projects/${projectId}/clips/${clip.exportId}/edit`);
  }

  async function handleDownload(clip: ClipItem) {
    if (!clip.signedUrl) return;

    try {
      setDownloadingId(clip.exportId);
      const res = await fetch(clip.signedUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      downloadClipBlob(blob, getClipFileName(clip));
    } catch (error) {
      console.error(error);
      window.alert('Download failed. Try again.');
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleShare(clip: ClipItem) {
    if (!clip.signedUrl || sharingId) return;

    try {
      setSharingId(clip.exportId);
      const response = await fetch(clip.signedUrl);
      if (!response.ok) throw new Error('Could not prepare this reel for sharing');

      const blob = await response.blob();
      const fileName = getClipFileName(clip);
      const file = new File([blob], fileName, { type: blob.type || 'video/mp4' });
      const shareData: ShareData = {
        files: [file],
        title: clip.title || 'AnimaCut reel',
        text: 'Created with AnimaCut',
      };

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share(shareData);
        return;
      }

      downloadClipBlob(blob, fileName);
      window.alert('This browser cannot send video files to social apps directly. The reel was downloaded so you can upload it to your social account.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error(error);
      window.alert('Could not open social sharing for this reel. Try again.');
    } finally {
      setSharingId(null);
    }
  }

  async function applyPreset(selectedPresetId: string, captionsEnabled: boolean) {
    if (!editingClip || !captionSettings) return;
    try {
      setApplyingPreset(true);
      const preset = CAPTION_TEMPLATE_OPTIONS.find((option) => option.id === selectedPresetId) ?? CAPTION_TEMPLATE_OPTIONS[0]!;
      const nextSettings: ClipEditSettings = {
        ...captionSettings,
        captions_enabled: captionsEnabled,
        caption_preset_id: DEFAULT_CAPTION_PRESET_ID,
        caption_font_size: 12,
        caption_text_color: '#FFFFFF',
        caption_highlight_color: preset.captionHighlightColor,
        caption_background: false,
        caption_word_highlight: true,
        caption_max_words: 2,
        caption_position: 'lower-third',
      };
      const presetRes = await fetch(`/api/clips/${editingClip.exportId}/rerender`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: nextSettings }),
      });
      const presetData = await readJsonSafe(presetRes);
      if (!presetRes.ok) throw new Error(String(presetData?.error || 'Could not apply preset'));
      refreshMediaOnNextUrlRef.current.add(editingClip.exportId);
      setOptimisticEditIds((current) => new Set(current).add(editingClip.exportId));
      setEditingClip(null);
      void fetch('/api/jobs/process', { method: 'POST', cache: 'no-store' }).catch(() => null);
    } catch (error) {
      console.error(error);
      window.alert(error instanceof Error ? error.message : 'Could not apply preset');
    } finally {
      setApplyingPreset(false);
    }
  }

  useEffect(() => {
    if (!editingClip) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditingClip(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editingClip]);

  const visible = useMemo(() => {
    return [...clips].sort((a, b) => b.score - a.score);
  }, [clips]);

  function stableMediaUrl(clip: ClipItem) {
    const nextUrl = clip.signedUrl ?? null;
    const currentUrl = stableMediaUrlsRef.current.get(clip.exportId) ?? null;
    const previousEditStatus = previousEditStatusesRef.current.get(clip.exportId);
    const editFinished = previousEditStatus === 'rendering' && clip.editStatus !== 'rendering';
    const waitingForEditedMedia = refreshMediaOnNextUrlRef.current.has(clip.exportId);

    if (nextUrl && (!currentUrl || (nextUrl !== currentUrl && (editFinished || waitingForEditedMedia)))) {
      stableMediaUrlsRef.current.set(clip.exportId, nextUrl);
      if (waitingForEditedMedia && nextUrl !== currentUrl) {
        refreshMediaOnNextUrlRef.current.delete(clip.exportId);
      }
    }
    previousEditStatusesRef.current.set(clip.exportId, clip.editStatus);
    return stableMediaUrlsRef.current.get(clip.exportId) ?? nextUrl;
  }

  useEffect(() => {
    const initialRenderActive = visible.some((clip) => clip.status === 'queued' || clip.status === 'processing');
    const activeEditIds = visible
      .filter((clip) => clip.editStatus === 'rendering' || optimisticEditIds.has(clip.exportId))
      .map((clip) => clip.exportId);
    const hasActiveClip = initialRenderActive || activeEditIds.length > 0;
    if (!hasActiveClip) return;

    const tick = async () => {
      if (renderKickInFlightRef.current) return;
      renderKickInFlightRef.current = true;
      try {
        await fetch('/api/jobs/process', { method: 'POST', cache: 'no-store' });
      } catch {
        // Best effort: the next tick or manual refresh can retry.
      } finally {
        renderKickInFlightRef.current = false;
      }

      if (initialRenderActive) {
        router.refresh();
        return;
      }

      if (activeEditIds.length) {
        const statuses = await Promise.all(activeEditIds.map(async (exportId) => {
          try {
            const response = await fetch(`/api/clips/${exportId}/edit`, { cache: 'no-store' });
            const payload = await readJsonSafe(response) as { clip?: { editStatus?: string | null } };
            return response.ok ? String(payload?.clip?.editStatus ?? '') : 'rendering';
          } catch {
            return 'rendering';
          }
        }));
        if (statuses.some((status) => status !== 'rendering')) {
          setOptimisticEditIds((current) => {
            const next = new Set(current);
            activeEditIds.forEach((id, index) => {
              if (statuses[index] !== 'rendering') next.delete(id);
            });
            return next;
          });
          router.refresh();
        }
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 5000);

    return () => clearInterval(timer);
  }, [optimisticEditIds, router, visible]);

  return (
    <>
      <section className="mt-6 space-y-3">
        <h2 className="px-4 text-lg font-semibold">Top clips</h2>

        {!visible.length && <p className="px-4 text-sm text-white/60">No clips yet.</p>}

        <div className="px-4 pb-2">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
            {visible.slice(0, 10).map((clip) => {
              const mediaUrl = stableMediaUrl(clip);
              const durationLabel = formatDuration(clip.startSec, clip.endSec);
              const playbackState = playback[clip.exportId];
              const current = playbackState?.current ?? 0;
              const duration = playbackState?.duration ?? 0;
              const totalLabel = duration > 0 ? formatClock(duration) : durationLabel ?? '0:00';
              const currentLabel = formatClock(current);
              const paused = playbackState?.paused ?? true;
              const volume = playbackState?.volume ?? 1;
              const progressPercent = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
              const displayScore = formatDisplayScore(clip.score);
              const primaryBadge = getPrimaryClipBadge(clip);
              const editRendering = clip.editStatus === 'rendering' || optimisticEditIds.has(clip.exportId);
              const pendingCaptionPreset =
                mediaUrl && clip.status !== 'done'
                  ? CAPTION_PRESETS.find((preset) =>
                      preset.captionHighlightColor.toLowerCase() === clip.captionHighlightColor?.toLowerCase()
                    ) ?? CAPTION_PRESETS.find((preset) => preset.id === clip.captionPresetId) ?? CAPTION_PRESETS[0]
                  : null;

              return (
                <article key={clip.exportId} className="group flex min-w-0 flex-col justify-between rounded-[10px] border border-transparent px-2.5 py-2.5 transition hover:border-white/12 hover:bg-white/[0.03]">
                  <div className="min-h-[78px] px-0.5 pb-1.5">
                    <p className="line-clamp-3 min-h-[52px] text-[15px] font-extrabold leading-[1.15rem] text-white">{clip.title}</p>

                    <div className="mx-auto mt-2 flex w-full max-w-[230px] items-center justify-between gap-3 px-1">
                      <div className="flex min-w-0 flex-nowrap items-center gap-2">
                        <span className="text-[28px] font-black leading-none tracking-tight" style={{ color: getScoreColor(clip.score) }}>
                          {displayScore}
                        </span>
                        <span className="max-w-[118px] truncate rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] font-bold text-white/82">
                          {primaryBadge}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-3 text-white">
                        <div className="group/edit relative">
                          <button
                            type="button"
                            onClick={() => openClipEditor(clip)}
                            disabled={editRendering}
                            className="inline-flex items-center justify-center text-white/90 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
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
                          <div className="group/share relative">
                            <button
                              type="button"
                              onClick={() => void handleShare(clip)}
                              disabled={Boolean(sharingId) || editRendering}
                              className="inline-flex items-center justify-center text-white/90 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                              aria-label="Share or publish clip"
                            >
                              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="18" cy="5" r="2.5" />
                                <circle cx="6" cy="12" r="2.5" />
                                <circle cx="18" cy="19" r="2.5" />
                                <path d="m8.2 10.8 7.6-4.5" />
                                <path d="m8.2 13.2 7.6 4.5" />
                              </svg>
                            </button>
                            <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/share:opacity-100">
                              {sharingId === clip.exportId ? 'Preparing reel...' : 'Share / publish'}
                            </span>
                          </div>
                        ) : null}

                        <div className="group/captions relative">
                          <button
                            type="button"
                            onClick={() => void openCaptionTemplates(clip)}
                            disabled={editRendering}
                            className="inline-flex items-center justify-center text-white/90 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                            aria-label="Captions"
                          >
                            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
                              <path d="M7.5 10.5h3" />
                              <path d="M13.5 10.5h3" />
                              <path d="M7.5 14h5" />
                              <path d="M14.5 14h2" />
                            </svg>
                          </button>
                          <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/captions:opacity-100">
                            Captions
                          </span>
                        </div>

                        {clip.signedUrl ? (
                          <div className="group/download relative">
                            <button
                              type="button"
                              onClick={() => handleDownload(clip)}
                              disabled={downloadingId === clip.exportId || editRendering}
                              className="inline-flex items-center justify-center text-white/90 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
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

                  {mediaUrl ? (
                    <div className="flex justify-center bg-transparent px-1.5">
                      <div
                        data-clip-frame="true"
                        onPointerEnter={() => primeVideo(clip.exportId, 'auto')}
                        onFocus={() => primeVideo(clip.exportId, 'auto')}
                        className="relative aspect-[9/16] w-full max-w-[230px] cursor-pointer overflow-hidden rounded-[8px] bg-[#15171c] ring-1 ring-white/10 transition group-hover:ring-white/22"
                      >
                        <video
                          ref={(el) => {
                            videoRefs.current[clip.exportId] = el;
                          }}
                          preload="metadata"
                          playsInline
                          controls={false}
                          disablePictureInPicture
                          poster={clip.posterUrl ?? undefined}
                          className="h-full w-full cursor-pointer bg-black object-cover"
                          src={mediaUrl}
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

                        {editRendering ? <ReelEditProcessingOverlay clip={clip} /> : null}

                        {pendingCaptionPreset && clip.captionsEnabled !== false ? (
                          <>
                            <div className="pointer-events-none absolute inset-x-0 bottom-[10%] h-[24%] bg-gradient-to-t from-black/90 via-black/82 to-transparent backdrop-blur-[1.5px]" />
                            <div className="pointer-events-none absolute inset-x-4 bottom-[18%] flex justify-center text-center">
                              <CaptionPreviewText preset={pendingCaptionPreset} title={clip.title} size="reel" />
                            </div>
                          </>
                        ) : null}

                        <div className="hidden">
                          <div className="rounded-md border border-black/35 bg-black/54 px-2.5 py-1 text-[18px] font-black leading-none tracking-tight shadow-[0_5px_16px_rgba(0,0,0,0.35)] backdrop-blur-sm" style={{ color: getScoreColor(clip.score) }}>
                            {displayScore}
                          </div>
                          <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-white/12 bg-black/45 px-2 py-1 text-white shadow-[0_5px_18px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                            <div className="group/edit relative">
                              <button
                                type="button"
                                onClick={() => openClipEditor(clip)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition hover:bg-white/12 hover:text-white"
                                aria-label="Edit clip"
                              >
                                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                                </svg>
                              </button>
                              <span className="pointer-events-none absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/edit:opacity-100">
                                Edit clip
                              </span>
                            </div>

                            {clip.signedUrl ? (
                              <div className="group/share relative">
                                <button
                                  type="button"
                                  onClick={() => void handleShare(clip)}
                                  disabled={Boolean(sharingId)}
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition hover:bg-white/12 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                                  aria-label="Share or publish clip"
                                >
                                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="18" cy="5" r="2.5" />
                                    <circle cx="6" cy="12" r="2.5" />
                                    <circle cx="18" cy="19" r="2.5" />
                                    <path d="m8.2 10.8 7.6-4.5" />
                                    <path d="m8.2 13.2 7.6 4.5" />
                                  </svg>
                                </button>
                                <span className="pointer-events-none absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/share:opacity-100">
                                  {sharingId === clip.exportId ? 'Preparing reel...' : 'Share / publish'}
                                </span>
                              </div>
                            ) : null}

                            <div className="group/captions relative">
                              <button
                                type="button"
                                onClick={() => void openCaptionTemplates(clip)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition hover:bg-white/12 hover:text-white"
                                aria-label="Captions"
                              >
                                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
                                  <path d="M7.5 10.5h3" />
                                  <path d="M13.5 10.5h3" />
                                  <path d="M7.5 14h5" />
                                  <path d="M14.5 14h2" />
                                </svg>
                              </button>
                              <span className="pointer-events-none absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/captions:opacity-100">
                                Captions
                              </span>
                            </div>

                            <div className="group/download relative">
                              <button
                                type="button"
                                onClick={() => handleDownload(clip)}
                                disabled={downloadingId === clip.exportId}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition hover:bg-white/12 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                                aria-label="Download clip"
                              >
                                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="M12 3v10" />
                                  <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
                                  <path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11A2.5 2.5 0 0 0 20 17.5v-2" />
                                </svg>
                              </button>
                              <span className="pointer-events-none absolute right-0 top-full z-30 mt-1 whitespace-nowrap rounded bg-white px-2.5 py-1 text-xs font-bold text-black opacity-0 shadow transition-opacity duration-100 group-hover/download:opacity-100">
                                Download clip
                              </span>
                            </div>
                          </div>
                        </div>

                        {paused ? (
                          <button
                            type="button"
                            onClick={() => togglePlay(clip.exportId)}
                            className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/30 text-white opacity-0 backdrop-blur-sm transition duration-200 hover:bg-black/45 focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
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
                            <span className="ml-auto shrink-0 rounded-full border border-white/15 bg-black/35 px-2.5 py-1 text-[11px] text-white/85 tabular-nums backdrop-blur-sm">
                              {currentLabel} / {totalLabel}
                            </span>
                          </div>

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
                            {displayScore}
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

      {editingClip ? (
        <CaptionTemplatesModal
          key={editingClip.exportId}
          clip={editingClip}
          defaultPresetId={captionModalDefaults.presetId}
          defaultCaptionsEnabled={captionModalDefaults.captionsEnabled}
          loading={loadingCaptionSettings}
          applying={applyingPreset}
          canApply={Boolean(captionSettings)}
          onClose={() => setEditingClip(null)}
          onApply={applyPreset}
        />
      ) : null}
    </>
  );
}

function CaptionTemplatesModal({
  clip,
  defaultPresetId,
  defaultCaptionsEnabled,
  loading,
  applying,
  canApply,
  onClose,
  onApply,
}: {
  clip: ClipItem;
  defaultPresetId: string;
  defaultCaptionsEnabled: boolean;
  loading: boolean;
  applying: boolean;
  canApply: boolean;
  onClose: () => void;
  onApply: (presetId: string, captionsEnabled: boolean) => Promise<void>;
}) {
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPresetId);
  const [captionsEnabled, setCaptionsEnabled] = useState(defaultCaptionsEnabled);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const activePreset = CAPTION_PRESETS.find((preset) => preset.id === selectedPresetId) ?? CAPTION_PRESETS[0]!;

  useEffect(() => {
    setSelectedPresetId(defaultPresetId);
    setCaptionsEnabled(defaultCaptionsEnabled);
  }, [defaultCaptionsEnabled, defaultPresetId]);

  useEffect(() => {
    const video = previewVideoRef.current;
    if (!video) return;
    video.preload = 'auto';
    video.load();
  }, [clip.signedUrl]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/70">
      <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-white/10 bg-[#0d0f14] shadow-[0_0_60px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Caption Templates</p>
            <h3 className="mt-1 text-lg font-semibold text-white">{clip.title}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-white/65 transition hover:text-white">
            Close
          </button>
        </div>

        <div className="grid flex-1 gap-0 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="border-b border-white/10 p-6 lg:border-b-0 lg:border-r">
            <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-black">
              {clip.signedUrl ? (
                <video
                  ref={previewVideoRef}
                  src={clip.signedUrl}
                  poster={clip.posterUrl ?? undefined}
                  controls
                  playsInline
                  preload="auto"
                  className="aspect-[9/16] w-full bg-black object-cover"
                />
              ) : (
                <div className="grid aspect-[9/16] place-items-center text-sm text-white/45">Preview unavailable</div>
              )}
              {captionsEnabled ? (
                <>
                  <div className="pointer-events-none absolute inset-x-0 bottom-[10%] h-[24%] bg-gradient-to-t from-black/95 via-black/88 to-transparent" />
                  <div className="pointer-events-none absolute inset-x-4 bottom-[18%] flex justify-center text-center">
                    <CaptionPreviewText preset={activePreset} title={clip.title} size="reel" />
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-black text-white">Caption style</p>
                <p className="mt-1 text-xs font-semibold text-white/55">Changes below preview instantly. Apply regenerates the reel.</p>
              </div>
              <label className="flex items-center gap-2 text-xs font-bold text-white/65">
                <input
                  type="checkbox"
                  checked={captionsEnabled}
                  onChange={(event) => setCaptionsEnabled(event.target.checked)}
                  disabled={loading}
                  className="accent-emerald-400"
                />
                On
              </label>
            </div>

            <div className="mt-5 rounded-2xl border border-cyan-300/70 bg-cyan-300/[0.06] p-3">
              <div className="grid aspect-[2.15] place-items-center rounded-xl border border-white/10 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,.12),rgba(255,255,255,.03)_42%,rgba(0,0,0,.55))]">
                {captionsEnabled ? (
                  <CaptionPreviewText preset={activePreset} title="Your caption" />
                ) : (
                  <span className="text-xs font-black uppercase tracking-[0.18em] text-white/35">Captions off</span>
                )}
              </div>
              <p className="mt-2 text-xs font-black text-white">Default bold captions</p>
            </div>

            <div className="mt-5 space-y-2">
              <p className="text-xs font-black text-white/70">Highlight color</p>
              <div className="flex flex-wrap gap-2">
                {CAPTION_TEMPLATE_OPTIONS.map((preset) => {
                  const active = preset.id === selectedPresetId;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setSelectedPresetId(preset.id)}
                      disabled={loading}
                      className={`h-9 w-9 rounded-full border-2 transition hover:scale-105 disabled:opacity-45 ${
                        active
                          ? 'border-white ring-2 ring-cyan-300/70 ring-offset-2 ring-offset-[#0d0f14]'
                          : 'border-white/20'
                      }`}
                      style={{ backgroundColor: preset.captionHighlightColor }}
                      aria-label={`Preview ${preset.name} highlight color`}
                      aria-pressed={active}
                      title={preset.name}
                    />
                  );
                })}
              </div>
            </div>

            <div className="mt-auto pt-6">
              <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-white/70">
                Preview colors instantly, then apply to regenerate this reel.
              </div>
              <button
                type="button"
                onClick={() => void onApply(selectedPresetId, captionsEnabled)}
                disabled={applying || loading || !canApply}
                className="w-full rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? 'Loading...' : applying ? 'Applying...' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
