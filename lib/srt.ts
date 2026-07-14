import { getVerticalExportSize } from '@/lib/export-profile';

type SegmentWord = {
  start?: number;
  end?: number;
  word?: string;
};

type Segment = {
  start?: number;
  end?: number;
  text?: string;
  words?: SegmentWord[];
};

type CaptionTemplate = 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut';
type StyledCaptionPreset = {
  caption_template?: CaptionTemplate;
  captionFontFamily?: string;
  captionFontSize?: number;
  captionTextColor?: string;
  captionHighlightColor?: string;
  captionStrokeColor?: string;
  captionStrokeWidth?: number;
  captionShadow?: string;
  captionBackgroundBox?: boolean;
  captionPosition?: string;
  captionWordHighlight?: boolean;
  captionMaxWords?: number;
};

function toSrtTime(sec: number) {
  const s = Math.max(0, sec);
  const hrs = Math.floor(s / 3600)
    .toString()
    .padStart(2, '0');
  const mins = Math.floor((s % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const secs = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  const ms = Math.floor((s - Math.floor(s)) * 1000)
    .toString()
    .padStart(3, '0');
  return `${hrs}:${mins}:${secs},${ms}`;
}

function chunkWords(text: string, maxWordsPerChunk = 6): string[] {
  const words = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  if (!words.length) return [];

  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWordsPerChunk) {
    chunks.push(words.slice(i, i + maxWordsPerChunk).join(' '));
  }
  return chunks;
}

function stylizeCapcutChunk(chunk: string) {
  return chunk
    .trim()
    .split(/\s+/)
    .map((w) => w.toUpperCase())
    .filter(Boolean)
    .join(' ');
}

export function segmentsToSrt(
  segments: Segment[],
  startSec: number,
  endSec: number,
  options?: { captionTemplate?: CaptionTemplate },
) {
  const sliced = segments
    .map((seg) => ({
      start: Number(seg.start ?? 0),
      end: Number(seg.end ?? 0),
      text: String(seg.text ?? '').trim(),
    }))
    .filter((seg) => seg.text && seg.end > startSec && seg.start < endSec);

  const items: Array<{ start: number; end: number; text: string }> = [];

  const isCapcut = options?.captionTemplate === 'capcut';

  for (const seg of sliced) {
    const localStart = Math.max(0, seg.start - startSec);
    const localEnd = Math.max(localStart + 0.2, Math.min(endSec, seg.end) - startSec);
    const duration = Math.max(0.2, localEnd - localStart);
    const chunks = chunkWords(seg.text, isCapcut ? 2 : 6);

    if (!chunks.length) continue;

    const chunkDur = duration / chunks.length;
    for (let i = 0; i < chunks.length; i += 1) {
      const s = localStart + i * chunkDur;
      const e = i === chunks.length - 1 ? localEnd : Math.max(s + 0.12, localStart + (i + 1) * chunkDur);
      const text = isCapcut ? stylizeCapcutChunk(chunks[i]) : chunks[i];
      items.push({ start: s, end: e, text });
    }
  }

  return items
    .map((item, idx) => `${idx + 1}\n${toSrtTime(item.start)} --> ${toSrtTime(item.end)}\n${item.text}\n`)
    .join('\n');
}

function toAssTime(sec: number) {
  const s = Math.max(0, sec);
  const hrs = Math.floor(s / 3600)
    .toString()
    .padStart(1, '0');
  const mins = Math.floor((s % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const secs = Math.floor(s % 60)
    .toString()
    .padStart(2, '0');
  const cs = Math.floor((s - Math.floor(s)) * 100)
    .toString()
    .padStart(2, '0');
  return `${hrs}:${mins}:${secs}.${cs}`;
}

function assEscape(text: string) {
  return text.replace(/[{}]/g, '').replace(/\\/g, '\\\\').trim();
}

function tokenizeCapcutWords(text: string) {
  return text
    .trim()
    .split(/\s+/)
    .map((w) => w.toUpperCase().replace(/[^A-Z0-9'?!.,-]/g, ''))
    .filter(Boolean)
    .map((w) => assEscape(w));
}

function hexToAssColor(hex: string | undefined, fallback: string) {
  const normalized = (hex || fallback).replace('#', '').trim();
  const safe = /^[0-9a-fA-F]{6}$/.test(normalized) ? normalized : fallback.replace('#', '');
  const rr = safe.slice(0, 2);
  const gg = safe.slice(2, 4);
  const bb = safe.slice(4, 6);
  return `&H00${bb}${gg}${rr}`;
}

function resolveAssFontName(preset: StyledCaptionPreset | undefined, template: CaptionTemplate) {
  const family = preset?.captionFontFamily?.trim();
  if (!family) return template === 'capcut' ? 'Montserrat' : 'Arial';
  if (/^Poppins ExtraBold$/i.test(family)) return family;
  return family.replace(/\s+(ExtraBold|Black|Bold|SemiBold)$/i, '') || family;
}

function resolveAssStyle(preset?: StyledCaptionPreset) {
  const exportSize = getVerticalExportSize();
  const template = preset?.caption_template ?? 'capcut';
  const fontScale = template === 'minimal' ? 7.4 : template === 'capcut' ? 9.8 : 8.6;
  const fontSize = Math.round((preset?.captionFontSize ?? 11) * fontScale);
  const outlineScale = template === 'minimal' ? 1 : template === 'capcut' ? 1.7 : 1;
  const outline = preset?.captionBackgroundBox
    ? 0
    : Math.max(template === 'capcut' ? 8 : 1, Math.round((preset?.captionStrokeWidth ?? 4) * outlineScale));
  const marginV = preset?.captionPosition === 'middle' || preset?.captionPosition === 'center'
    ? Math.round(exportSize.height * 0.375)
    : preset?.captionPosition === 'upper'
      ? Math.round(exportSize.height * 0.583)
      : template === 'minimal'
        ? Math.round(exportSize.height * 0.156)
        : Math.round(exportSize.height * 0.198);
  const boxBackColor = preset?.captionBackgroundBox && preset?.captionTextColor?.toUpperCase() === '#111111'
    ? '&H00FFFFFF'
    : '&HCC000000';
  const shadow =
    preset?.captionShadow === 'subtle-shadow' ? 1 :
    preset?.captionShadow === 'clean-shadow' ? 1 :
    preset?.captionShadow === 'bubble-shadow' ? 1 :
    preset?.captionShadow ? 2 :
    template === 'capcut' ? 2 :
    0;

  return {
    template,
    fontName: resolveAssFontName(preset, template),
    fontSize,
    primary: hexToAssColor(preset?.captionTextColor, '#FFFFFF'),
    secondary: hexToAssColor(preset?.captionHighlightColor, '#21F45A'),
    outlineColor: hexToAssColor(preset?.captionStrokeColor, '#000000'),
    outline,
    shadow,
    borderStyle: preset?.captionBackgroundBox ? 3 : 1,
    backColor: preset?.captionBackgroundBox ? boxBackColor : '&H00000000',
    marginV,
    scaleX: template === 'minimal' ? 100 : template === 'clean' ? 106 : template === 'capcut' ? 106 : 122,
    scaleY: template === 'minimal' ? 100 : template === 'capcut' ? 110 : 108,
    windowSize: Math.max(1, Math.min(6, Math.round(preset?.captionMaxWords ?? (template === 'minimal' || template === 'clean' || template === 'cinematic' ? 4 : 2)))),
    wordHighlight: preset?.captionWordHighlight !== false,
    playResX: exportSize.width,
    playResY: exportSize.height,
  };
}

function buildHighlightedLine(
  words: string[],
  activeWordIdx: number,
  options?: {
    primary: string;
    secondary: string;
    scaleX: number;
    scaleY: number;
  },
) {
  const primary = options?.primary ?? '&H00FFFFFF';
  const secondary = options?.secondary ?? '&H0000FFFF';
  const primaryOverride = primary.endsWith('&') ? primary : `${primary}&`;
  const secondaryOverride = secondary.endsWith('&') ? secondary : `${secondary}&`;
  const baseScaleX = options?.scaleX ?? 100;
  const baseScaleY = options?.scaleY ?? 100;
  const popScaleX = Math.round(baseScaleX * 1.08);
  const popScaleY = Math.round(baseScaleY * 1.08);
  const settleScaleX = Math.round(baseScaleX * 1.04);
  const settleScaleY = Math.round(baseScaleY * 1.04);

  return words
    .map((w, idx) => {
      if (idx !== activeWordIdx) return w;

      // Give the spoken word a quick, restrained pop, then leave it slightly
      // enlarged for the rest of its audio interval. The following reset keeps
      // every other word at the caption template's normal scale.
      return `{\\c${secondaryOverride}\\fscx${baseScaleX}\\fscy${baseScaleY}\\t(0,80,\\fscx${popScaleX}\\fscy${popScaleY})\\t(80,180,\\fscx${settleScaleX}\\fscy${settleScaleY})}${w}{\\c${primaryOverride}\\fscx${baseScaleX}\\fscy${baseScaleY}}`;
    })
    .join(' ');
}

export function segmentsToCapcutAss(segments: Segment[], startSec: number, endSec: number, preset?: StyledCaptionPreset) {
  const style = resolveAssStyle(preset);
  const sliced = segments
    .map((seg) => ({
      start: Number(seg.start ?? 0),
      end: Number(seg.end ?? 0),
      text: String(seg.text ?? '').trim(),
      words: Array.isArray(seg.words)
        ? seg.words
            .map((w) => ({
              start: Number(w?.start ?? 0),
              end: Number(w?.end ?? 0),
              word: String(w?.word ?? '').trim(),
            }))
            .filter((w) => w.word && w.end > startSec && w.start < endSec)
        : [],
    }))
    .filter((seg) => seg.text && seg.end > startSec && seg.start < endSec);

  const events: Array<{ start: number; end: number; text: string }> = [];

  for (const seg of sliced) {
    const localStart = Math.max(0, seg.start - startSec);
    const localEnd = Math.max(localStart + 0.2, Math.min(endSec, seg.end) - startSec);
    const duration = Math.max(0.2, localEnd - localStart);

    const timedWords = (seg.words ?? [])
      .map((w) => ({
        word: assEscape(String(w.word ?? '').toUpperCase().replace(/[^A-Z0-9'?!.,-]/g, '')),
        start: Math.max(localStart, Number(w.start) - startSec),
        end: Math.min(localEnd, Number(w.end) - startSec),
      }))
      .filter((w) => w.word && w.end > w.start);

    const words = timedWords.length ? timedWords.map((w) => w.word) : tokenizeCapcutWords(seg.text);
    if (!words.length) continue;

    // Prefer real per-word [start,end] intervals. Fallback only when no word timings exist.
    const intervals: Array<{ start: number; end: number; word: string }> = [];

    if (timedWords.length) {
      for (const tw of timedWords) {
        intervals.push({ start: tw.start, end: tw.end, word: tw.word });
      }
    } else {
      const weights = words.map((w) => Math.max(1, w.replace(/[^A-Z0-9]/g, '').length));
      const weightSum = weights.reduce((sum, w) => sum + w, 0) || words.length;

      let cursor = localStart;
      for (let i = 0; i < words.length; i += 1) {
        const s = cursor;
        cursor += duration * (weights[i] / weightSum);
        const e = i === words.length - 1 ? localEnd : Math.max(s + 0.04, cursor);
        intervals.push({ start: s, end: e, word: words[i] });
      }
    }

    const lineWordsAll = intervals.map((it) => it.word);
    const windowSize = style.windowSize;
    for (let windowStart = 0; windowStart < lineWordsAll.length; windowStart += windowSize) {
      const windowEnd = Math.min(lineWordsAll.length, windowStart + windowSize);
      const lineWords = lineWordsAll.slice(windowStart, windowEnd);

      if (!style.wordHighlight) {
        const s = Math.max(localStart, intervals[windowStart]?.start ?? localStart);
        const e = Math.min(localEnd, intervals[windowEnd - 1]?.end ?? localEnd);
        const text = lineWords.join(' ');
        if (text && e - s >= 0.05) events.push({ start: s, end: e, text });
        continue;
      }

      for (let i = windowStart; i < windowEnd; i += 1) {
        const rawS = intervals[i].start;
        const rawE = intervals[i].end;

        // Use model-provided word boundaries directly (no hardcoded lead).
        // This avoids globally "fast" or "slow" behavior and follows the audio timing.
        const s = Math.max(localStart, rawS);
        let e = Math.max(s + 0.04, Math.min(localEnd, rawE));

        // Keep within segment bounds and avoid ultra-short flashes.
        if (e > localEnd) e = localEnd;
        if (e - s < 0.05) continue;

        const activeInLine = i - windowStart;
        const text = buildHighlightedLine(lineWords, activeInLine, {
          primary: style.primary,
          secondary: style.secondary,
          scaleX: style.scaleX,
          scaleY: style.scaleY,
        });
        if (!text) continue;

        events.push({ start: s, end: e, text });
      }
    }
  }

  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${style.playResX}\nPlayResY: ${style.playResY}\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${style.fontName},${style.fontSize},${style.primary},${style.secondary},${style.outlineColor},${style.backColor},-1,0,0,0,${style.scaleX},${style.scaleY},0,0,${style.borderStyle},${style.outline},${style.shadow},2,30,30,${style.marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const body = events
    .map((e) => `Dialogue: 0,${toAssTime(e.start)},${toAssTime(e.end)},Default,,0,0,0,,${e.text}`)
    .join('\n');

  return `${header}${body}\n`;
}
