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

function buildHighlightedLine(words: string[], activeWordIdx: number) {
  return words
    .map((w, idx) => (idx === activeWordIdx ? `{\\c&H00FFFF&}${w}{\\c&H00FFFFFF&}` : w))
    .join(' ');
}

export function segmentsToCapcutAss(segments: Segment[], startSec: number, endSec: number) {
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
    const windowSize = 2;
    for (let windowStart = 0; windowStart < lineWordsAll.length; windowStart += windowSize) {
      const windowEnd = Math.min(lineWordsAll.length, windowStart + windowSize);
      const lineWords = lineWordsAll.slice(windowStart, windowEnd);

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
        const text = buildHighlightedLine(lineWords, activeInLine);
        if (!text) continue;

        events.push({ start: s, end: e, text });
      }
    }
  }

  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Impact,108,&H00FFFFFF,&H0000FFFF,&H00101010,&H00000000,-1,0,0,0,126,108,0,0,1,8,0,2,30,30,450,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const body = events
    .map((e) => `Dialogue: 0,${toAssTime(e.start)},${toAssTime(e.end)},Default,,0,0,0,,${e.text}`)
    .join('\n');

  return `${header}${body}\n`;
}
