import { DEFAULT_CAPTION_PRESET_ID, getCaptionPresetById } from '@/lib/caption-presets';

export type TranscriptPhrase = {
  id: string;
  start: number;
  end: number;
  text: string;
  originalText: string;
  deleted?: boolean;
};

export type ClipEditSettings = {
  clip_start_seconds: number;
  clip_end_seconds: number;
  edited_transcript: TranscriptPhrase[];
  captions_enabled: boolean;
  caption_preset_id: string;
  caption_font_size: number;
  caption_text_color: string;
  caption_highlight_color: string;
  caption_position: 'upper' | 'center' | 'lower-third';
  caption_word_highlight: boolean;
  caption_background: boolean;
  caption_max_words: number;
  framing_mode: 'auto' | 'center' | 'fit' | 'manual';
  crop_x: number;
  crop_y: number;
  zoom: number;
  removed_ranges: Array<{ start: number; end: number }>;
};

export type TranscriptSegment = {
  start?: number;
  end?: number;
  text?: string;
  words?: Array<{ start?: number; end?: number; word?: string }>;
};

export function phraseId(index: number, start: number, end: number) {
  return `p-${index}-${Math.round(start * 100)}-${Math.round(end * 100)}`;
}

export function transcriptSegmentsToPhrases(segments: TranscriptSegment[]) {
  return segments
    .map((segment, index) => {
      const start = Number(segment.start ?? 0);
      const end = Number(segment.end ?? start);
      const text = String(segment.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return {
        id: phraseId(index, start, end),
        start,
        end,
        text,
        originalText: text,
      };
    })
    .filter((phrase): phrase is TranscriptPhrase => Boolean(phrase));
}

export function phrasesToSegments(phrases: TranscriptPhrase[]): TranscriptSegment[] {
  return phrases
    .filter((phrase) => !phrase.deleted && phrase.text.trim() && phrase.end > phrase.start)
    .map((phrase) => ({
      start: phrase.start,
      end: phrase.end,
      text: phrase.text.trim(),
      words: [],
    }));
}

function finiteNumber(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeColor(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function normalizeCaptionPosition(value: unknown): ClipEditSettings['caption_position'] {
  if (value === 'upper' || value === 'center' || value === 'lower-third') return value;
  if (value === 'middle') return 'center';
  return 'lower-third';
}

function normalizeFramingMode(value: unknown): ClipEditSettings['framing_mode'] {
  if (value === 'auto' || value === 'center' || value === 'fit' || value === 'manual') return value;
  return 'auto';
}

function normalizePhrases(value: unknown, fallback: TranscriptPhrase[]): TranscriptPhrase[] {
  if (!Array.isArray(value)) return fallback;
  const phrases: TranscriptPhrase[] = [];

  value.forEach((item, index) => {
    const row = item as Record<string, unknown>;
    const start = finiteNumber(row.start, NaN);
    const end = finiteNumber(row.end, NaN);
    const text = typeof row.text === 'string' ? row.text.replace(/\s+/g, ' ').trim() : '';
    const originalText = typeof row.originalText === 'string' ? row.originalText.replace(/\s+/g, ' ').trim() : text;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    phrases.push({
      id: typeof row.id === 'string' && row.id ? row.id : phraseId(index, start, end),
      start,
      end,
      text,
      originalText,
      deleted: row.deleted === true,
    });
  });

  return phrases.length ? phrases : fallback;
}

export function buildDefaultClipEditSettings(params: {
  aiStart: number;
  aiEnd: number;
  sourceDuration: number;
  transcriptPhrases: TranscriptPhrase[];
  captionPresetId?: string | null;
}): ClipEditSettings {
  const preset = getCaptionPresetById(params.captionPresetId ?? DEFAULT_CAPTION_PRESET_ID);
  const maxEnd = Math.max(params.aiEnd, params.sourceDuration || params.aiEnd);
  return {
    clip_start_seconds: clamp(params.aiStart, 0, Math.max(0, maxEnd - 10)),
    clip_end_seconds: clamp(params.aiEnd, Math.min(maxEnd, params.aiStart + 10), maxEnd),
    edited_transcript: params.transcriptPhrases,
    captions_enabled: true,
    caption_preset_id: preset.id,
    caption_font_size: preset.captionFontSize,
    caption_text_color: preset.captionTextColor,
    caption_highlight_color: preset.captionHighlightColor,
    caption_position: normalizeCaptionPosition(preset.captionPosition),
    caption_word_highlight: preset.captionWordHighlight,
    caption_background: preset.captionBackgroundBox,
    caption_max_words: preset.captionMaxWords,
    framing_mode: 'auto',
    crop_x: 0.5,
    crop_y: 0.34,
    zoom: 1,
    removed_ranges: [],
  } satisfies ClipEditSettings;
}

export function normalizeClipEditSettings(raw: unknown, defaults: ClipEditSettings, sourceDuration: number): ClipEditSettings {
  const row = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
  const maxEnd = Math.max(10, sourceDuration || defaults.clip_end_seconds);
  const start = clamp(finiteNumber(row.clip_start_seconds, defaults.clip_start_seconds), 0, Math.max(0, maxEnd - 10));
  const end = clamp(finiteNumber(row.clip_end_seconds, defaults.clip_end_seconds), start + 10, Math.min(maxEnd, start + 90));
  const preset = getCaptionPresetById(typeof row.caption_preset_id === 'string' ? row.caption_preset_id : defaults.caption_preset_id);

  return {
    clip_start_seconds: start,
    clip_end_seconds: end,
    edited_transcript: normalizePhrases(row.edited_transcript, defaults.edited_transcript),
    captions_enabled: row.captions_enabled !== false,
    caption_preset_id: preset.id,
    caption_font_size: Math.round(clamp(finiteNumber(row.caption_font_size, defaults.caption_font_size), 8, 24)),
    caption_text_color: normalizeColor(row.caption_text_color, defaults.caption_text_color),
    caption_highlight_color: normalizeColor(row.caption_highlight_color, defaults.caption_highlight_color),
    caption_position: normalizeCaptionPosition(row.caption_position ?? defaults.caption_position),
    caption_word_highlight: row.caption_word_highlight !== false,
    caption_background: row.caption_background === true,
    caption_max_words: Math.round(clamp(finiteNumber(row.caption_max_words, defaults.caption_max_words), 1, 6)),
    framing_mode: normalizeFramingMode(row.framing_mode ?? defaults.framing_mode),
    crop_x: clamp(finiteNumber(row.crop_x, defaults.crop_x), 0, 1),
    crop_y: clamp(finiteNumber(row.crop_y, defaults.crop_y), 0, 1),
    zoom: clamp(finiteNumber(row.zoom, defaults.zoom), 1, 2.4),
    removed_ranges: Array.isArray(row.removed_ranges)
      ? row.removed_ranges
        .map((item) => {
          const range = item as Record<string, unknown>;
          const rangeStart = clamp(finiteNumber(range.start, NaN), start, end);
          const rangeEnd = clamp(finiteNumber(range.end, NaN), rangeStart, end);
          return Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd - rangeStart >= 0.15
            ? { start: rangeStart, end: rangeEnd }
            : null;
        })
        .filter((item): item is { start: number; end: number } => Boolean(item))
      : defaults.removed_ranges,
  } satisfies ClipEditSettings;
}

export function hasClipEditSettings(raw: unknown) {
  return Boolean(raw && typeof raw === 'object' && Object.keys(raw as Record<string, unknown>).length > 0);
}
