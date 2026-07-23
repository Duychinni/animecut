import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getVerticalExportSize } from '@/lib/export-profile';
import { buildRenderOutputArgs, type SourceColorMetadata } from '@/lib/ffmpeg-output-args';

type CaptionTemplate = 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut';
type CaptionFont = 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';

type ReframeMode = 'off' | 'basic' | 'smart';
const VERTICAL_EXPORT_SIZE = getVerticalExportSize();
const VERTICAL_EXPORT_WIDTH = VERTICAL_EXPORT_SIZE.width;
const VERTICAL_EXPORT_HEIGHT = VERTICAL_EXPORT_SIZE.height;
const RENDER_ALIGNMENT_VERSION = 'smart-speaker-follow-v13-fixed-region-authority';
// Preserve detail through crop/scale, caption compositing, and the additional
// recompression applied by social platforms. The separate playback preview
// keeps dashboard playback responsive.
const DEFAULT_X264_CRF = '18';
const DEFAULT_X264_MAXRATE = '12M';
const DEFAULT_X264_BUFSIZE = '24M';
const DEFAULT_HW_VIDEO_BITRATE = '10M';
const DEFAULT_HW_MAXRATE = '12M';
const DEFAULT_HW_BUFSIZE = '24M';
const HIGH_QUALITY_SCALE_FLAGS = 'lanczos+accurate_rnd+full_chroma_int';
const SHARPEN_AFTER_UPSCALE_FILTER = 'unsharp=5:5:0.55:3:3:0.25';
const MAX_EXTRA_SMART_CROP_UPSCALE = 1.04;

function resolveMediaBinary(name: 'ffmpeg' | 'ffprobe') {
  const configured = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH']?.trim();
  if (configured) return configured;
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const localBinary = path.join(/* turbopackIgnore: true */ process.cwd(), '.tools', 'ffmpeg', 'bin', executable);
  return existsSync(localBinary) ? localBinary : name;
}

type RenderOpts = {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  fastRender?: boolean;
  srtPath?: string;
  captionsEnabled?: boolean;
  captionTemplate?: CaptionTemplate;
  captionFont?: CaptionFont;
  hookTextEnabled?: boolean;
  hookText?: string | null;
  hookPlacement?: 'top' | 'middle';
  hookRenderMode?: 'ass' | 'drawtext';
  hookTextFilePath?: string;
  hookAssPath?: string;
  motionTracking?: boolean;
  autoReframe?: boolean;
  reframeMode?: ReframeMode;
  reframePreset?: 'auto' | 'tight' | 'left' | 'center' | 'right';
  framingMode?: 'auto' | 'center' | 'fit' | 'manual';
  cropX?: number;
  cropY?: number;
  zoom?: number;
  volume?: number;
  debugReframeOverlay?: boolean;
  debugClipId?: string;
  debugCandidateId?: string;
  editorialPlan?: Record<string, unknown> | null;
  speakerTurns?: Array<{ speaker_key: string | null; start_sec: number; end_sec: number; confidence: number | null }>;
};

export async function extractVideoThumbnail(inputPath: string, outputPath: string, atSeconds = 5) {
  await runFfmpeg([
    '-y',
    '-ss', String(atSeconds),
    '-i', inputPath,
    '-frames:v', '1',
    '-q:v', '2',
    '-vf', 'scale=1280:-2',
    outputPath,
  ]);
}

export async function extractAudioForTranscription(inputPath: string, outputPath: string) {
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'mp3',
    '-b:a', '64k',
    outputPath,
  ]);
}

export async function validateRenderedVideo(outputPath: string) {
  const result = await runJsonCommand(resolveMediaBinary('ffprobe'), [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt',
    '-of', 'json',
    outputPath,
  ]);

  const data = result.json as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      pix_fmt?: string;
    }>;
    format?: { duration?: string; size?: string };
  };

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? 0);
  const size = Number(data.format?.size ?? 0);
  const stderr = (result.stderr || '').trim();
  const decodeErrors = /Invalid NAL unit|missing picture|Error splitting the input into NAL units|co located POCs unavailable|Prediction is not allowed|channel element .* is not allocated|Missing reference picture|mmco:/i.test(stderr);

  if (result.code !== 0) {
    throw new Error(`Rendered export failed ffprobe validation: ${stderr || 'ffprobe error'}`);
  }

  if (!video || !video.width || !video.height) {
    throw new Error('Rendered export is missing a valid video stream');
  }

  if (video.width !== VERTICAL_EXPORT_WIDTH || video.height !== VERTICAL_EXPORT_HEIGHT) {
    throw new Error(`Rendered export must be ${VERTICAL_EXPORT_WIDTH}x${VERTICAL_EXPORT_HEIGHT}; got ${video.width}x${video.height}`);
  }

  if (!audio) {
    throw new Error('Rendered export is missing an audio stream');
  }

  if (!Number.isFinite(duration) || duration <= 0.25) {
    throw new Error('Rendered export duration is invalid');
  }

  if (!Number.isFinite(size) || size < 128 * 1024) {
    throw new Error('Rendered export file is suspiciously small');
  }

  if (decodeErrors) {
    throw new Error(`Rendered export is corrupted: ${stderr.split('\n').slice(0, 4).join(' | ')}`);
  }

  return {
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio.codec_name ?? null,
    pixelFormat: video.pix_fmt ?? null,
    duration,
    size,
    frameRate: video.avg_frame_rate ?? null,
  };
}

export async function extractBestVideoThumbnail(inputPath: string, outputPath: string, durationSeconds: number, editorialPlan?: Record<string, unknown> | null) {
  const script = process.env.THUMBNAIL_SELECTOR_SCRIPT || path.join(/* turbopackIgnore: true */ process.cwd(), 'scripts', 'select_thumbnail.py');
  try {
    let editorialPlanPath: string | null = null;
    if (editorialPlan) {
      editorialPlanPath = `${outputPath}.editorial-plan.json`;
      await writeFile(editorialPlanPath, JSON.stringify(editorialPlan, null, 2), 'utf8');
    }
    const result = await runJsonCommand(resolveSmartReframePython(), [
      script,
      inputPath,
      outputPath,
      String(Math.max(0.25, durationSeconds)),
      ...(editorialPlanPath ? [editorialPlanPath] : []),
    ]);
    const payload = result.json as { ok?: boolean; selected_timestamp?: number; selected_score?: number; selected_faces?: number };
    if (!payload.ok || !existsSync(outputPath)) throw new Error('Thumbnail selector did not produce an image');
    return payload;
  } catch (error) {
    console.warn('[thumbnail] visual scoring unavailable; using representative FFmpeg frame', {
      error: error instanceof Error ? error.message : String(error),
    });
    const safeStart = Math.max(0.25, durationSeconds * 0.08);
    const safeDuration = Math.max(0.5, durationSeconds * 0.82);
    await runFfmpeg([
      '-y',
      '-ss', String(safeStart),
      '-t', String(safeDuration),
      '-i', inputPath,
      '-vf', 'thumbnail=120,scale=1280:-2',
      '-frames:v', '1',
      '-q:v', '2',
      outputPath,
    ]);
    return { ok: true, selected_timestamp: null, selected_score: null, selected_faces: null };
  }
}

async function probeInputVideoForRender(inputPath: string) {
  const result = await runJsonCommand(resolveMediaBinary('ffprobe'), [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,bit_rate,color_space,color_transfer,color_primaries',
    '-of', 'json',
    inputPath,
  ]);
  const data = result.json as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      bit_rate?: string;
      color_space?: string;
      color_transfer?: string;
      color_primaries?: string;
    }>;
    format?: { duration?: string; size?: string; bit_rate?: string };
  };
  const video = (data.streams ?? []).find((stream) => stream.codec_type === 'video');
  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    codec: video?.codec_name ?? null,
    fps: video?.avg_frame_rate ?? null,
    videoBitrate: video?.bit_rate ?? null,
    containerBitrate: data.format?.bit_rate ?? null,
    duration: data.format?.duration ?? null,
    size: data.format?.size ?? null,
    colorSpace: video?.color_space ?? null,
    colorTransfer: video?.color_transfer ?? null,
    colorPrimaries: video?.color_primaries ?? null,
  };
}

function escapeSubtitlesPathForFilter(path: string) {
  return path
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,');
}

function escapeForceStyleForFilter(style: string) {
  return style.replace(/'/g, "\\'").replace(/:/g, '\\:');
}

export async function renderCutVideo(
  inputPath: string,
  outputPath: string,
  ranges: Array<{ start: number; end: number }>,
) {
  const validRanges = ranges.filter((range) => range.end - range.start >= 0.15);
  if (!validRanges.length) throw new Error('No playable timeline remains after cuts');

  const filters = validRanges.flatMap((range, index) => [
    `[0:v]trim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`,
    `[0:a]atrim=start=${range.start.toFixed(3)}:end=${range.end.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`,
  ]);
  const concatInputs = validRanges.map((_, index) => `[v${index}][a${index}]`).join('');
  filters.push(`${concatInputs}concat=n=${validRanges.length}:v=1:a=1[outv][outa]`);

  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', process.env.FFMPEG_EDIT_X264_PRESET || 'veryfast',
    '-crf', '10',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

/**
 * Produce the low-latency rendition used by project preview cards. The full
 * 1080x1920 export remains the download/editing master. The project cards only
 * render at multiple sizes, so use a 540x960 rendition that remains crisp when
 * opened larger while still being much lighter than the 1080x1920 master.
 */
export async function renderPlaybackPreview(inputPath: string, outputPath: string, quality: '360p' | '540p' = '540p') {
  const constrained = quality === '360p';
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `scale=${constrained ? '360:640' : '540:960'}:flags=lanczos+accurate_rnd+full_chroma_int,fps=${constrained ? 24 : 30}`,
    '-c:v', 'libx264',
    '-preset', process.env.FFMPEG_PREVIEW_X264_PRESET || 'veryfast',
    '-crf', constrained ? '25' : '23',
    '-maxrate', constrained ? '950k' : '2500k',
    '-bufsize', constrained ? '1900k' : '5000k',
    '-pix_fmt', 'yuv420p',
    '-g', constrained ? '48' : '60',
    '-keyint_min', constrained ? '24' : '30',
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', constrained ? '80k' : '128k',
    '-ar', '48000',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

function captionFontsDirOption() {
  const configuredDir = process.env.CAPTION_FONTS_DIR?.trim();
  const fontsDir = configuredDir || path.join(/* turbopackIgnore: true */ process.cwd(), 'public', 'fonts');
  return existsSync(fontsDir) ? `:fontsdir='${escapeSubtitlesPathForFilter(fontsDir)}'` : '';
}

function shellQuote(arg: string) {
  return /[^A-Za-z0-9_./:=,+-]/.test(arg) ? `'${arg.replace(/'/g, `'"'"'`)}'` : arg;
}

function formatCommand(cmd: string, args: string[]) {
  return [cmd, ...args].map(shellQuote).join(' ');
}

async function writeDebugCommandFile(clipId: string, commandText: string, outputPath: string, args: string[]) {
  const debugDir = process.env.SMART_REFRAME_DEBUG_DIR?.trim() || path.join(/* turbopackIgnore: true */ process.cwd(), 'tmp', 'reframe-debug');
  await mkdir(debugDir, { recursive: true });
  const filterIndex = args.indexOf('-filter_complex');
  const filterGraph = filterIndex >= 0 ? args[filterIndex + 1] ?? null : null;
  const bundle = {
    clipId,
    outputPath,
    ffmpegCommand: commandText,
    ffmpegArgs: args,
    filterGraph,
  };
  await writeFile(path.join(debugDir, `${clipId}.ffmpeg-command.txt`), `${commandText}\n`, 'utf8');
  if (filterGraph) await writeFile(path.join(debugDir, `${clipId}.filter-graph.txt`), `${filterGraph}\n`, 'utf8');
  await writeFile(path.join(debugDir, `${clipId}.bundle.json`), JSON.stringify(bundle, null, 2), 'utf8');
}

async function runFfmpeg(args: string[], debug?: { clipId?: string | null; outputPath?: string | null }) {
  const ffmpegCommand = resolveMediaBinary('ffmpeg');
  const commandText = formatCommand(ffmpegCommand, args);
  const configuredTimeoutSeconds = Number(process.env.FFMPEG_RENDER_TIMEOUT_SECONDS ?? 0);
  const startIndex = args.indexOf('-ss');
  const endIndex = args.indexOf('-to');
  const startSec = startIndex >= 0 ? Number(args[startIndex + 1] ?? 0) : 0;
  const endSec = endIndex >= 0 ? Number(args[endIndex + 1] ?? 0) : 0;
  const expectedDuration = Number.isFinite(endSec - startSec) ? Math.max(1, endSec - startSec) : 60;
  const timeoutSeconds = Number.isFinite(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0
    ? Math.max(60, Math.min(1800, configuredTimeoutSeconds))
    : Math.max(240, Math.min(900, Math.ceil(expectedDuration * 12 + 120)));
  console.log('[ffmpeg] command', { clipId: debug?.clipId ?? null, outputPath: debug?.outputPath ?? null, command: commandText });
  if (debug?.clipId && debug?.outputPath) {
    await writeDebugCommandFile(debug.clipId, commandText, debug.outputPath, args);
  }
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegCommand, args);
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutSeconds * 1000);

    p.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-128_000);
    });

    p.on('close', (code) => {
      clearTimeout(timeout);
      const tail = stderr.trim().split('\n').slice(-12).join('\n');
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${timeoutSeconds}s${tail ? `\n${tail}` : ''}`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg failed: ${code}${tail ? `\n${tail}` : ''}`));
    });
    p.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function runJsonCommand(cmd: string, args: string[]) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string; json: unknown }>((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';

    p.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    p.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    p.on('close', (code) => {
      try {
        resolve({
          code,
          stdout,
          stderr,
          json: JSON.parse(stdout.trim() || '{}'),
        });
      } catch {
        reject(new Error(`${cmd} returned non-JSON output`));
      }
    });
    p.on('error', reject);
  });
}

function parseSrtTimeToSec(ts: string) {
  const [hms, ms = '0'] = ts.trim().split(',');
  const [hh = '0', mm = '0', ss = '0'] = hms.split(':');
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

function parseAssTimeToSec(ts: string) {
  const [hms, cs = '0'] = ts.trim().split('.');
  const [hh = '0', mm = '0', ss = '0'] = hms.split(':');
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(cs) / 100;
}

function stripAssOverrides(text: string) {
  return text.replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ').trim();
}

function escapeDrawtextText(text: string) {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%');
}

function escapeDrawtextPathForFilter(filePath: string) {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,');
}

function drawtextBetween(start: number, end: number) {
  return `enable=between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})`;
}

async function buildDrawtextFiltersFromSrt(srtPath: string) {
  const raw = await readFile(srtPath, 'utf8');
  const filters: string[] = [];

  // Support both .srt and .ass for fallback caption burn-in.
  const looksLikeAss = /^\s*\[Script Info\]/m.test(raw) || /^\s*Dialogue:/m.test(raw);

  if (looksLikeAss) {
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue;
      const body = line.replace(/^Dialogue:\s*\d+\s*,/, '');
      const parts = body.split(',');
      if (parts.length < 10) continue;

      const start = parseAssTimeToSec(parts[0] ?? '0:00:00.00');
      const end = parseAssTimeToSec(parts[1] ?? '0:00:00.20');
      const textRaw = parts.slice(9).join(',');
      const plain = stripAssOverrides(textRaw);
      const text = escapeDrawtextText(plain);
      if (!text) continue;

      filters.push(
        `drawtext=text='${text}':font='Arial Black':fontcolor=white:fontsize=114:borderw=11:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=black@0.85:x=(w-text_w)/2:y=h-620:${drawtextBetween(start, end)}`,
      );
    }

    return filters;
  }

  const blocks = raw.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length < 3) continue;

    const timeLine = lines[1];
    const match = timeLine.match(/(\d\d:\d\d:\d\d,\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d,\d\d\d)/);
    if (!match) continue;

    const start = parseSrtTimeToSec(match[1]);
    const end = parseSrtTimeToSec(match[2]);
    const text = escapeDrawtextText(lines.slice(2).join(' ').trim());
    if (!text) continue;

    filters.push(
      `drawtext=text='${text}':font='Arial Black':fontcolor=white:fontsize=114:borderw=11:bordercolor=black:shadowx=2:shadowy=2:shadowcolor=black@0.85:x=(w-text_w)/2:y=h-620:${drawtextBetween(start, end)}`,
    );
  }

  return filters;
}

type ReframePoint = {
  t: number;
  nx: number;
  ny: number;
  w?: number;
  h?: number;
  framing?: string;
  mode?: string;
  shotId?: number;
  cut?: boolean;
  audioActivity?: number;
  speakerConfidence?: number;
};
type SubjectBox = { x: number; y: number; w: number; h: number; cx?: number; cy?: number };
type SplitStackLayout = {
  mode: 'split_stack';
  sourceW: number;
  sourceH: number;
  topBox: SubjectBox;
  bottomBox: SubjectBox;
  cropWidth: number;
  outputWidth: number;
  outputHeight: number;
};
type FramingInterval = { start: number; end: number };
type TimelineLayoutMode = 'single' | 'stacked' | 'grid' | 'wide_context' | 'source_vertical';
type WideContextKind = 'two_person' | 'broll' | 'safe_wide';
type GridTemplate = 'stack_2' | 'hero_3' | 'grid_3' | 'grid_4';
type TimelineSubject = { trackId: number; box: SubjectBox; score: number };
type ReframeTimelinePoint = {
  t: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  cropCenterX?: number;
  cropCenterY?: number;
  zoom?: number;
  speakerConfidence?: number;
};
type ReframeTimelineSegment = {
  start: number;
  end: number;
  mode: TimelineLayoutMode;
  primaryTrackId?: number | null;
  topTrackId?: number | null;
  bottomTrackId?: number | null;
  wideKind?: WideContextKind;
  gridTemplate?: GridTemplate;
  subjects?: TimelineSubject[];
  topBox?: SubjectBox;
  bottomBox?: SubjectBox;
  editorialSceneType?: string;
  editorialLayout?: string;
  editorialReason?: string;
  points: ReframeTimelinePoint[];
};
type SmartReframeResult = {
  cropExpr?: string;
  layout?: SplitStackLayout;
  wideIntervals?: FramingInterval[];
  timeline?: ReframeTimelineSegment[];
  sourceW?: number;
  sourceH?: number;
};

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function smoothPoints(points: ReframePoint[], alpha = 0.35) {
  if (!points.length) return points;
  const out: ReframePoint[] = [];
  let sx = points[0].nx;
  let sy = points[0].ny;

  for (const p of points) {
    sx = alpha * p.nx + (1 - alpha) * sx;
    sy = alpha * p.ny + (1 - alpha) * sy;
    out.push({
      ...p,
      nx: clamp01(sx),
      ny: clamp01(sy),
    });
  }

  return out;
}

function downsamplePoints(points: ReframePoint[], maxPoints = 12) {
  if (points.length <= maxPoints) return points;
  const out: ReframePoint[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(points.length - 1, Math.round((i / (maxPoints - 1)) * (points.length - 1)));
    out.push(points[idx]);
  }
  return out;
}

function stabilizeReframePoints(points: ReframePoint[], maxPoints = 48) {
  if (!points.length) return points;
  const shots: ReframePoint[][] = [];
  for (const point of points) {
    const current = shots[shots.length - 1];
    if (!current || point.cut || point.shotId !== current[0].shotId) shots.push([point]);
    else current.push(point);
  }

  const total = points.length;
  return shots.flatMap((shot) => {
    // Smooth only inside a stable shot. Never average the outgoing speaker into
    // the incoming speaker's crop at a real cut.
    const smoothed = smoothPoints(shot, 0.38);
    const allocation = Math.max(2, Math.round(maxPoints * (shot.length / total)));
    const sampled = downsamplePoints(smoothed, allocation);
    if (sampled.length) sampled[0] = { ...sampled[0], cut: shot[0].cut };
    return sampled;
  });
}

function collectFramingIntervals(points: ReframePoint[], clipDuration: number): FramingInterval[] {
  const intervals: FramingInterval[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point.framing !== 'wide_context') continue;

    const start = Math.max(0, point.t - 0.18);
    const end = Math.min(clipDuration, points[index + 1]?.t ?? clipDuration);
    if (end - start < 0.12) continue;

    const previous = intervals[intervals.length - 1];
    if (previous && start <= previous.end + 0.3) previous.end = Math.max(previous.end, end);
    else intervals.push({ start, end });
  }

  return intervals.filter((interval) => interval.end - interval.start >= 0.35);
}

function buildTimelineExpr(points: ReframePoint[], pick: (p: ReframePoint) => string, fallback: string) {
  if (!points.length) return fallback;
  let expr = pick(points[points.length - 1]);
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const a = points[i];
    const b = points[i + 1];
    expr = `if(between(t,${a.t.toFixed(3)},${b.t.toFixed(3)}),${pick(a)},${expr})`;
  }
  return expr;
}

function escapeFfmpegExpr(expr: string) {
  // In filtergraphs, commas split filters unless escaped.
  // Crop expressions use functions like min/max/if/between that contain commas,
  // so we must escape them before injecting into -vf.
  return expr.replace(/,/g, '\\,');
}

function resolveSmartReframePython() {
  const localCandidates = process.platform === 'win32'
    ? [path.join(/* turbopackIgnore: true */ process.cwd(), '.venv', 'Scripts', 'python.exe')]
    : [path.join(/* turbopackIgnore: true */ process.cwd(), '.venv', 'bin', 'python')];
  const localPython = localCandidates.find((candidate) => existsSync(candidate));
  if (localPython) return localPython;

  // The checked, repo-local runtime is authoritative. A stale machine-level
  // SMART_REFRAME_PYTHON previously bypassed `worker:check`, loaded a newer
  // incompatible MediaPipe package, and silently disabled subject framing.
  const configured = process.env.SMART_REFRAME_PYTHON?.trim();
  if (configured) {
    const looksLikePath = configured.includes('/') || configured.includes('\\') || path.isAbsolute(configured);
    if (!looksLikePath || existsSync(path.resolve(configured))) return configured;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

function resolveSmartReframeScript() {
  return process.env.SMART_REFRAME_SCRIPT || path.join(/* turbopackIgnore: true */ process.cwd(), 'scripts', 'reframe_per_clip.py');
}

function resolveSmartReframeCvScript() {
  return process.env.SMART_REFRAME_CV_SCRIPT || path.join(/* turbopackIgnore: true */ process.cwd(), 'scripts', 'reframe_cv.py');
}

function normalizeBox(box: Partial<SubjectBox> | null | undefined): SubjectBox | undefined {
  if (!box) return undefined;
  const x = Number(box.x ?? 0);
  const y = Number(box.y ?? 0);
  const w = Number(box.w ?? 0);
  const h = Number(box.h ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w <= 1 || h <= 1) return undefined;
  return { x, y, w, h, cx: Number(box.cx ?? (x + w / 2)), cy: Number(box.cy ?? (y + h / 2)) };
}

function normalizeReframeTimeline(rawTimeline: unknown, clipDuration: number): ReframeTimelineSegment[] {
  if (!Array.isArray(rawTimeline)) return [];
  const validModes = new Set<TimelineLayoutMode>(['single', 'stacked', 'grid', 'wide_context', 'source_vertical']);
  const segments = rawTimeline.flatMap((raw): ReframeTimelineSegment[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const mode = String(item.mode ?? '') as TimelineLayoutMode;
    if (!validModes.has(mode)) return [];
    const start = clamp(Number(item.start ?? 0), 0, clipDuration);
    const end = clamp(Number(item.end ?? clipDuration), 0, clipDuration);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.05) return [];
    const rawWideKind = String(item.wideKind ?? 'safe_wide');
    const wideKind: WideContextKind = rawWideKind === 'two_person' || rawWideKind === 'broll'
      ? rawWideKind
      : 'safe_wide';
    const rawGridTemplate = String(item.gridTemplate ?? '');
    const gridTemplate: GridTemplate | undefined = rawGridTemplate === 'stack_2' || rawGridTemplate === 'hero_3' || rawGridTemplate === 'grid_3' || rawGridTemplate === 'grid_4'
      ? rawGridTemplate
      : undefined;
    const subjects = Array.isArray(item.subjects)
      ? item.subjects.flatMap((rawSubject): TimelineSubject[] => {
          if (!rawSubject || typeof rawSubject !== 'object') return [];
          const subject = rawSubject as Record<string, unknown>;
          const box = normalizeBox(subject.box as Partial<SubjectBox> | null | undefined);
          const trackId = Number(subject.trackId);
          const score = Number(subject.score ?? 0);
          return box && Number.isFinite(trackId) ? [{ trackId, box, score: Number.isFinite(score) ? score : 0 }] : [];
        })
      : [];
    const points = Array.isArray(item.points)
      ? item.points.flatMap((rawPoint): ReframeTimelinePoint[] => {
          if (!rawPoint || typeof rawPoint !== 'object') return [];
          const point = rawPoint as Record<string, unknown>;
          const t = Number(point.t ?? start);
          const cropX = Number(point.cropX ?? 0);
          const cropY = Number(point.cropY ?? 0);
          const cropW = Number(point.cropW ?? 0);
          const cropH = Number(point.cropH ?? 0);
          if (![t, cropX, cropY, cropW, cropH].every(Number.isFinite) || cropW <= 1 || cropH <= 1) return [];
          return [{
            t: clamp(t, start, end),
            cropX,
            cropY,
            cropW,
            cropH,
            cropCenterX: Number(point.cropCenterX ?? (cropX + cropW / 2)),
            cropCenterY: Number(point.cropCenterY ?? (cropY + cropH / 2)),
            zoom: Number(point.zoom ?? 1),
            speakerConfidence: Number(point.speakerConfidence ?? 0),
          }];
        }).sort((a, b) => a.t - b.t)
      : [];
    return [{
      start,
      end,
      mode,
      primaryTrackId: item.primaryTrackId == null || item.primaryTrackId === '' ? null : Number.isFinite(Number(item.primaryTrackId)) ? Number(item.primaryTrackId) : null,
      topTrackId: item.topTrackId == null || item.topTrackId === '' ? null : Number.isFinite(Number(item.topTrackId)) ? Number(item.topTrackId) : null,
      bottomTrackId: item.bottomTrackId == null || item.bottomTrackId === '' ? null : Number.isFinite(Number(item.bottomTrackId)) ? Number(item.bottomTrackId) : null,
      wideKind,
      gridTemplate,
      subjects,
      topBox: normalizeBox(item.topBox as Partial<SubjectBox> | null | undefined),
      bottomBox: normalizeBox(item.bottomBox as Partial<SubjectBox> | null | undefined),
      editorialSceneType: typeof item.editorialSceneType === 'string' ? item.editorialSceneType : undefined,
      editorialLayout: typeof item.editorialLayout === 'string' ? item.editorialLayout : undefined,
      editorialReason: typeof item.editorialReason === 'string' ? item.editorialReason : undefined,
      points,
    }];
  }).sort((a, b) => a.start - b.start);

  if (!segments.length) return [];
  segments[0].start = 0;
  for (let index = 1; index < segments.length; index += 1) {
    const boundary = clamp(segments[index].start, segments[index - 1].start + 0.05, clipDuration);
    segments[index - 1].end = boundary;
    segments[index].start = boundary;
  }
  segments[segments.length - 1].end = clipDuration;
  return segments.filter((segment) => segment.end - segment.start >= 0.05);
}

function medianSubjectBoxes(items: SubjectBox[]): SubjectBox | undefined {
  if (!items.length) return undefined;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return {
    x: median(items.map((item) => item.x)),
    y: median(items.map((item) => item.y)),
    w: median(items.map((item) => item.w)),
    h: median(items.map((item) => item.h)),
    cx: median(items.map((item) => item.cx ?? (item.x + item.w / 2))),
    cy: median(items.map((item) => item.cy ?? (item.y + item.h / 2))),
  };
}

function strongestSeparatedFacePair(faces: SubjectBox[], sourceW: number, sourceH: number) {
  let best: [SubjectBox, SubjectBox] | undefined;
  let bestScore = -1;
  const sourceArea = Math.max(1, sourceW * sourceH);

  for (let firstIndex = 0; firstIndex < faces.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < faces.length; secondIndex += 1) {
      const first = faces[firstIndex];
      const second = faces[secondIndex];
      const firstCenter = first.cx ?? (first.x + first.w / 2);
      const secondCenter = second.cx ?? (second.x + second.w / 2);
      const separation = Math.abs(secondCenter - firstCenter) / Math.max(1, sourceW);
      if (separation < 0.14) continue;
      const firstArea = first.w * first.h;
      const secondArea = second.w * second.h;
      const sizeBalance = Math.min(firstArea, secondArea) / Math.max(1, Math.max(firstArea, secondArea));
      const pairPresence = Math.sqrt(firstArea * secondArea) / sourceArea;
      const score = pairPresence * (0.55 + separation) * (0.4 + sizeBalance * 0.6);
      if (score > bestScore) {
        bestScore = score;
        best = firstCenter <= secondCenter ? [first, second] : [second, first];
      }
    }
  }

  return best;
}

function maybeBuildSplitStackLayout(raw: {
  mode?: string;
  source_w?: number;
  source_h?: number;
  detected_faces?: Array<{ faces?: Array<{ x?: number; y?: number; w?: number; h?: number; cx?: number; cy?: number; track_id?: number; predicted?: boolean }> }>;
}): SplitStackLayout | undefined {
  if (raw.mode !== 'split_stack') return undefined;
  const sourceW = Number(raw.source_w ?? 0);
  const sourceH = Number(raw.source_h ?? 0);
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW < 100 || sourceH < 100) return undefined;

  const leftFaces: SubjectBox[] = [];
  const rightFaces: SubjectBox[] = [];
  const boxesByTrack = new Map<number, SubjectBox[]>();
  for (const frame of raw.detected_faces ?? []) {
    const faces = (frame.faces ?? []).map((face) => {
      const box = normalizeBox(face);
      const trackId = Number(face.track_id);
      if (box && Number.isFinite(trackId)) {
        const existing = boxesByTrack.get(trackId) ?? [];
        existing.push(box);
        boxesByTrack.set(trackId, existing);
      }
      return box;
    }).filter(Boolean) as SubjectBox[];
    if (faces.length < 2) continue;
    const pair = strongestSeparatedFacePair(faces, sourceW, sourceH);
    if (!pair) continue;
    leftFaces.push(pair[0]);
    rightFaces.push(pair[1]);
  }

  const stableTracks = [...boxesByTrack.entries()]
    .map(([trackId, boxes]) => ({ trackId, boxes, median: medianSubjectBoxes(boxes) }))
    .filter((track): track is { trackId: number; boxes: SubjectBox[]; median: SubjectBox } => Boolean(track.median))
    .sort((a, b) => b.boxes.length - a.boxes.length);

  let stablePair: [SubjectBox, SubjectBox] | undefined;
  let stablePairScore = -1;
  for (let firstIndex = 0; firstIndex < stableTracks.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < stableTracks.length; secondIndex += 1) {
      const first = stableTracks[firstIndex];
      const second = stableTracks[secondIndex];
      const firstCenter = first.median.cx ?? (first.median.x + first.median.w / 2);
      const secondCenter = second.median.cx ?? (second.median.x + second.median.w / 2);
      const separation = Math.abs(secondCenter - firstCenter) / Math.max(1, sourceW);
      if (separation < 0.14) continue;
      const score = Math.min(first.boxes.length, second.boxes.length) * (0.6 + separation);
      if (score > stablePairScore) {
        stablePairScore = score;
        stablePair = firstCenter <= secondCenter
          ? [first.median, second.median]
          : [second.median, first.median];
      }
    }
  }

  const topBox = stablePair?.[0] ?? medianSubjectBoxes(leftFaces);
  const bottomBox = stablePair?.[1] ?? medianSubjectBoxes(rightFaces);
  if (!topBox || !bottomBox) return undefined;

  return {
    mode: 'split_stack',
    sourceW,
    sourceH,
    topBox,
    bottomBox,
    cropWidth: Math.round(sourceH * 9 / 16),
    outputWidth: VERTICAL_EXPORT_WIDTH,
    outputHeight: VERTICAL_EXPORT_HEIGHT,
  };
}

function largestSourceCropForOutput(sourceW: number, sourceH: number, outputW: number, outputH: number) {
  const targetAspect = outputW / outputH;
  const sourceAspect = sourceW / sourceH;

  if (!Number.isFinite(targetAspect) || !Number.isFinite(sourceAspect) || sourceW <= 0 || sourceH <= 0) {
    return null;
  }

  if (sourceAspect >= targetAspect) {
    return {
      cropW: sourceH * targetAspect,
      cropH: sourceH,
    };
  }

  return {
    cropW: sourceW,
    cropH: sourceW / targetAspect,
  };
}

async function maybeBuildSmartCropExpression(opts: RenderOpts): Promise<SmartReframeResult> {
  if (opts.framingMode && opts.framingMode !== 'auto') {
    console.log('[smart-reframe]', {
      clipId: opts.debugClipId ?? null,
      candidateId: opts.debugCandidateId ?? null,
      enabled: false,
      reason: 'manual_framing_override',
      framingMode: opts.framingMode,
    });
    return {};
  }

  if (opts.reframeMode !== 'smart' || opts.autoReframe === false) {
    console.log('[smart-reframe]', {
      clipId: opts.debugClipId ?? null,
      candidateId: opts.debugCandidateId ?? null,
      enabled: false,
      reason: opts.autoReframe === false ? 'auto_reframe_disabled' : 'reframe_mode_not_smart',
    });
    return {};
  }

  try {
    let editorialPlanPath: string | null = null;
    let speakerTurnsPath: string | null = null;
    if (opts.editorialPlan) {
      const plannerDir = path.join(/* turbopackIgnore: true */ process.cwd(), 'tmp', 'editorial-plans');
      await mkdir(plannerDir, { recursive: true });
      editorialPlanPath = path.join(plannerDir, `${opts.debugCandidateId ?? opts.debugClipId ?? 'clip'}.json`);
      await writeFile(editorialPlanPath, JSON.stringify(opts.editorialPlan, null, 2), 'utf8');
    }
    if (opts.speakerTurns?.length) {
      const plannerDir = path.join(/* turbopackIgnore: true */ process.cwd(), 'tmp', 'editorial-plans');
      await mkdir(plannerDir, { recursive: true });
      speakerTurnsPath = path.join(plannerDir, `${opts.debugCandidateId ?? opts.debugClipId ?? 'clip'}.speaker-turns.json`);
      await writeFile(speakerTurnsPath, JSON.stringify(opts.speakerTurns, null, 2), 'utf8');
    }
    let script = resolveSmartReframeScript();
    let probe = await runJsonCommand(resolveSmartReframePython(), [
      script,
      opts.inputPath,
      String(opts.startSec),
      String(opts.endSec),
      process.env.SMART_REFRAME_ANALYSIS_FPS || '4',
      ...(editorialPlanPath || speakerTurnsPath ? [editorialPlanPath ?? ''] : []),
      ...(speakerTurnsPath ? [speakerTurnsPath] : []),
    ]);
    let raw = probe.json as {
      ok?: boolean;
      mode?: string;
      source_w?: number;
      source_h?: number;
      crop_w?: number;
      crop_h?: number;
      detected_center_x?: number;
      crop_x?: number;
      ffmpeg_crop?: string;
      fallback_used?: boolean;
      samples?: Array<{ timestamp?: number; detected_face?: { x?: number; y?: number; w?: number; h?: number }; chosen_center_x?: number; chosen_center_y?: number; fallback_used?: boolean }>;
      points?: Array<{
        t?: number;
        nx?: number;
        ny?: number;
        w?: number;
        h?: number;
        framing?: string;
        mode?: string;
        shot_id?: number;
        cut?: boolean;
        audio_activity?: number;
        speaker_confidence?: number;
      }>;
      reframe_timeline?: unknown;
      meta?: {
        points?: number;
        frames_with_detection_pct?: number;
        average_face_center?: { x?: number; y?: number };
        fallback_used?: boolean;
        audio_available?: boolean;
        speaker_switches?: number;
        confident_speaker_samples?: number;
        wide_context_samples?: number;
        dual_frames?: number;
        dual_observation_opportunities?: number;
        dual_frame_ratio?: number;
        analysis_rate_fps?: number;
        timeline_segments?: number;
        layout_mode_changes?: number;
        layout_modes?: string[];
      };
      detected_faces?: Array<{ faces?: Array<{ x?: number; y?: number; w?: number; h?: number }> }>;
      error?: string;
    };

    if (probe.code !== 0 || !raw?.ok) {
      const primaryFailure = {
        clipId: opts.debugClipId ?? null,
        candidateId: opts.debugCandidateId ?? null,
        reason: probe.code !== 0 ? 'python_probe_nonzero_exit' : 'raw_not_ok',
        probeCode: probe.code,
        detectorError: raw?.error ?? (probe.stderr.trim() || null),
        raw,
      };
      console.log('[smart-reframe-detector-retry]', primaryFailure);

      const cvScript = resolveSmartReframeCvScript();
      if (cvScript !== script) {
        const cvProbe = await runJsonCommand(resolveSmartReframePython(), [
          cvScript,
          opts.inputPath,
          String(opts.startSec),
          String(opts.endSec),
          process.env.SMART_REFRAME_ANALYSIS_FPS || '4',
        ]);
        const cvRaw = cvProbe.json as typeof raw;
        if (cvProbe.code === 0 && cvRaw?.ok) {
          script = cvScript;
          probe = cvProbe;
          raw = cvRaw;
          console.log('[smart-reframe-detector-retry]', {
            clipId: opts.debugClipId ?? null,
            candidateId: opts.debugCandidateId ?? null,
            recovered: true,
            backendScript: cvScript,
          });
        } else {
          console.log('[smart-reframe-fallback]', {
            ...primaryFailure,
            cvProbeCode: cvProbe.code,
            cvError: cvRaw?.error ?? (cvProbe.stderr.trim() || null),
          });
          return {};
        }
      } else {
        console.log('[smart-reframe-fallback]', primaryFailure);
        return {};
      }
    }

    const clipId = (opts.debugClipId ?? opts.outputPath.split('/').pop()?.replace(/\.mp4$/, '')) || 'unknown';
    const candidateId = opts.debugCandidateId ?? null;
    const backendScript = script;
    let jsonSaved = false;

    if (process.env.DEBUG_REFRAME_SAVE_JSON === 'true') {
      const debugDir = process.env.SMART_REFRAME_DEBUG_DIR?.trim() || path.join(/* turbopackIgnore: true */ process.cwd(), 'tmp', 'reframe-debug');
      await mkdir(debugDir, { recursive: true });
      await writeFile(`${debugDir}/${clipId}.json`, JSON.stringify(raw, null, 2), 'utf8');
      jsonSaved = true;
    }

    const clipDuration = Math.max(0.01, opts.endSec - opts.startSec);
    const reframeTimeline = normalizeReframeTimeline(raw.reframe_timeline, clipDuration);
    if (reframeTimeline.length) {
      console.log('[smart-reframe-layout-timeline]', {
        clipId,
        candidateId,
        segments: reframeTimeline.length,
        modeChanges: Math.max(0, reframeTimeline.length - 1),
        modes: reframeTimeline.map((segment) => segment.mode),
        timeline: reframeTimeline.map((segment) => ({
          start: segment.start,
          end: segment.end,
          mode: segment.mode,
          wideKind: segment.wideKind ?? null,
          primaryTrackId: segment.primaryTrackId ?? null,
          topTrackId: segment.topTrackId ?? null,
          bottomTrackId: segment.bottomTrackId ?? null,
          editorialSceneType: segment.editorialSceneType ?? null,
          editorialLayout: segment.editorialLayout ?? null,
        })),
        identities: reframeTimeline.map((segment) => ({
          primaryTrackId: segment.primaryTrackId ?? null,
          topTrackId: segment.topTrackId ?? null,
          bottomTrackId: segment.bottomTrackId ?? null,
        })),
      });
      return {
        timeline: reframeTimeline,
        sourceW: Number(raw.source_w ?? 0) || undefined,
        sourceH: Number(raw.source_h ?? 0) || undefined,
      };
    }

    const detectionPct = Number(raw.meta?.frames_with_detection_pct ?? NaN);
    const samples = raw.samples ?? [];
    const directFaceSamples = samples.filter((sample) => sample.detected_face && !sample.fallback_used).length;
    const detectedFaceFrames = (raw.detected_faces ?? []).filter((frame) => (frame.faces?.length ?? 0) > 0).length;
    const evidenceBase = Math.max(samples.length, raw.detected_faces?.length ?? 0);
    const minimumFaceEvidence = Math.max(2, Math.ceil(evidenceBase * 0.12));
    const hasReliableFaceEvidence = directFaceSamples >= minimumFaceEvidence || detectedFaceFrames >= minimumFaceEvidence;
    const sampleConfidence = samples.length ? directFaceSamples / samples.length : 1;
    const lowDetectionConfidence = Number.isFinite(detectionPct) && detectionPct < 0.2;
    const lowSampleConfidence = samples.length > 0 && sampleConfidence < 0.2;

    if ((lowDetectionConfidence || lowSampleConfidence) && !hasReliableFaceEvidence) {
      console.log('[smart-reframe-fallback]', {
        clipId,
        candidateId,
        reason: 'low_subject_detection_confidence',
        framesWithDetectionPct: Number.isFinite(detectionPct) ? detectionPct : null,
        sampleConfidence,
        sampleCount: samples.length,
        directFaceSamples,
        detectedFaceFrames,
        minimumFaceEvidence,
        rawMode: raw.mode ?? null,
      });
      return {};
    }

    const dynamicPointCount = raw.points?.length ?? 0;
    const forceStaticPerClipCrop = process.env.SMART_REFRAME_DYNAMIC === 'false';
    if (
      raw.mode === 'per_clip'
      && typeof raw.crop_w === 'number'
      && typeof raw.crop_h === 'number'
      && typeof raw.crop_x === 'number'
      && (forceStaticPerClipCrop || dynamicPointCount < 2)
    ) {
      const outputHeight = resolveOutputHeight();
      const outputWidth = resolveOutputWidth(outputHeight);
      const sourceW = Number(raw.source_w ?? 0);
      const sourceH = Number(raw.source_h ?? 0);
      const scale = sourceW > 0 && sourceH > 0
        ? Math.max(outputWidth / sourceW, outputHeight / sourceH)
        : 1;
      const scaledW = sourceW * scale;
      const scaledH = sourceH * scale;
      let rawCropW = clamp(Number(raw.crop_w), 1, sourceW || Number(raw.crop_w));
      let rawCropH = clamp(Number(raw.crop_h), 1, sourceH || Number(raw.crop_h));
      let rawCropX = clamp(Number(raw.crop_x ?? 0), 0, Math.max(0, sourceW - rawCropW));
      let rawCropY = clamp(Number((raw as { crop_y?: number }).crop_y ?? 0), 0, Math.max(0, sourceH - rawCropH));
      const largestSourceCrop = sourceW > 0 && sourceH > 0
        ? largestSourceCropForOutput(sourceW, sourceH, outputWidth, outputHeight)
        : null;
      const extraSmartCropUpscale = largestSourceCrop
        ? Math.max(largestSourceCrop.cropW / rawCropW, largestSourceCrop.cropH / rawCropH)
        : null;
      let cropWidenedForQuality = false;

      if (largestSourceCrop && extraSmartCropUpscale && extraSmartCropUpscale > MAX_EXTRA_SMART_CROP_UPSCALE) {
        const centerX = rawCropX + rawCropW / 2;
        const centerY = rawCropY + rawCropH / 2;
        rawCropW = clamp(largestSourceCrop.cropW, 1, sourceW);
        rawCropH = clamp(largestSourceCrop.cropH, 1, sourceH);
        rawCropX = clamp(centerX - rawCropW / 2, 0, Math.max(0, sourceW - rawCropW));
        rawCropY = clamp(centerY - rawCropH / 2, 0, Math.max(0, sourceH - rawCropH));
        cropWidenedForQuality = true;
      }

      const scaledCropW = floorEven(clamp(Math.round(rawCropW * scale), Math.min(outputWidth, 360), scaledW));
      const scaledCropH = floorEven(clamp(Math.round(rawCropH * scale), Math.min(outputHeight, 640), scaledH));
      const scaledCropX = clamp(rawCropX * scale, 0, Math.max(0, scaledW - scaledCropW));
      const scaledCropY = clamp(rawCropY * scale, 0, Math.max(0, scaledH - scaledCropH));
      const cropExpr = `crop=${Math.round(scaledCropW)}:${Math.round(scaledCropH)}:${Math.round(scaledCropX)}:${Math.round(scaledCropY)}`;
      const effectiveSourceCropW = scale > 0 ? rawCropW : null;
      const upscaleRatio = effectiveSourceCropW && effectiveSourceCropW > 0 ? outputWidth / effectiveSourceCropW : null;
      const sourceToOutputUpscaleRatio = rawCropW > 0 && rawCropH > 0
        ? Math.max(outputWidth / rawCropW, outputHeight / rawCropH)
        : null;
      console.log('[smart-reframe]', {
        clipId,
        candidateId,
        backendScript,
        mode: raw.mode,
        source_w: raw.source_w ?? null,
        source_h: raw.source_h ?? null,
        crop_x: rawCropX,
        crop_y: rawCropY,
        crop_w: rawCropW,
        crop_h: rawCropH,
        original_crop_x: raw.crop_x,
        original_crop_y: (raw as { crop_y?: number }).crop_y ?? 0,
        original_crop_w: raw.crop_w,
        original_crop_h: raw.crop_h,
        largest_source_crop_w: largestSourceCrop?.cropW ?? null,
        largest_source_crop_h: largestSourceCrop?.cropH ?? null,
        extra_smart_crop_upscale: extraSmartCropUpscale,
        crop_widened_for_quality: cropWidenedForQuality,
        scaled_crop_x: Math.round(scaledCropX),
        scaled_crop_y: Math.round(scaledCropY),
        scaled_crop_w: Math.round(scaledCropW),
        scaled_crop_h: Math.round(scaledCropH),
        scaled_crop_expr: cropExpr,
        effective_source_crop_w: effectiveSourceCropW,
        approximate_horizontal_upscale_ratio: upscaleRatio,
        source_to_output_upscale_ratio: sourceToOutputUpscaleRatio,
        detected_center_x: raw.detected_center_x ?? null,
        fallbackUsed: raw.fallback_used ?? null,
        ffmpeg_crop: raw.ffmpeg_crop ?? null,
        jsonSaved,
        dynamicPointCount,
        forceStaticPerClipCrop,
      });
      return { cropExpr };
    }

    console.log('[smart-reframe]', {
      clipId,
      candidateId,
      backendScript,
      smartCropReturnedPoints: Boolean(raw?.points?.length),
      detectionsFound: raw?.meta?.points ?? raw.points?.length ?? 0,
      averageFaceCenterX: raw?.meta?.average_face_center?.x ?? null,
      averageFaceCenterY: raw?.meta?.average_face_center?.y ?? null,
      framesWithDetectionPct: raw?.meta?.frames_with_detection_pct ?? null,
      fallbackUsed: raw?.meta?.fallback_used ?? null,
      jsonSaved,
    });

    const pointsSource = raw.points ?? [];
    const points = pointsSource
      .map((p) => ({
        t: Number(p.t ?? 0),
        nx: clamp01(Number(p.nx ?? 0.5)),
        ny: clamp01(Number(p.ny ?? 0.42)),
        w: Number(p.w ?? 0),
        h: Number(p.h ?? 0),
        framing: typeof p.framing === 'string' ? p.framing : undefined,
        mode: typeof p.mode === 'string' ? p.mode : undefined,
        shotId: Number.isFinite(Number(p.shot_id)) ? Number(p.shot_id) : 0,
        cut: p.cut === true,
        audioActivity: Number(p.audio_activity ?? 0),
        speakerConfidence: Number(p.speaker_confidence ?? 0),
      }))
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);

    if (points.length < 2) {
      console.log('[smart-reframe-fallback]', {
        clipId,
        candidateId,
        reason: 'insufficient_timeline_points',
        pointsLength: points.length,
        rawMode: raw.mode ?? null,
      });
      return {};
    }

    const stabilized = stabilizeReframePoints(points, 48);
    const wideIntervals = collectFramingIntervals(stabilized, Math.max(0.01, opts.endSec - opts.startSec));

    console.log('[smart-reframe-active-speaker]', {
      clipId,
      candidateId,
      audioAvailable: raw.meta?.audio_available ?? null,
      speakerSwitches: raw.meta?.speaker_switches ?? null,
      confidentSpeakerSamples: raw.meta?.confident_speaker_samples ?? null,
      analysisRateFps: raw.meta?.analysis_rate_fps ?? null,
      sourcePoints: points.length,
      stabilizedPoints: stabilized.length,
      framingShots: new Set(stabilized.map((point) => point.shotId ?? 0)).size,
      wideContextSamples: raw.meta?.wide_context_samples ?? null,
      wideIntervals,
    });

    const preset = opts.reframePreset ?? 'auto';
    const cropWidth = VERTICAL_EXPORT_WIDTH;
    const cropHeight = VERTICAL_EXPORT_HEIGHT;

    const xExprRaw = buildTimelineExpr(
      stabilized,
      (p) => {
        const baseBias = p.framing === 'wide_pair' ? 0.5 : clamp01(p.nx);
        const presetBias = preset === 'left' ? 0.38 : preset === 'right' ? 0.62 : preset === 'center' ? 0.5 : baseBias;
        const pairBias = preset === 'center' ? 0.5 : presetBias;
        const centerDamp = preset === 'tight' ? 0 : p.framing === 'wide_pair' ? 0 : p.framing === 'single_stable' ? 0.03 : 0.05;
        const subjectX = clamp01(0.5 + (pairBias - 0.5) * (1 - centerDamp));
        const screenX = preset === 'left' ? 0.46 : preset === 'right' ? 0.54 : 0.5;
        return `min(max(iw*${subjectX.toFixed(4)}-${cropWidth}*${screenX.toFixed(4)},0),iw-${cropWidth})`;
      },
      `(iw-${cropWidth})/2`,
    );

    // Better podcast/interview framing: keep eyes in the upper-middle instead of centering the whole body.
    const yExprRaw = buildTimelineExpr(
      stabilized,
      (p) => {
        const isPair = p.framing === 'wide_pair';
        const isStableSingle = p.framing === 'single_stable';
        const headroomBias = preset === 'tight' ? 0.34 : isPair ? 0.04 : isStableSingle ? 0.34 : 0.3;
        const target = clamp01((p.ny ?? 0.42) - headroomBias);
        return `min(max((ih-${cropHeight})*${target.toFixed(4)},0),ih-${cropHeight})`;
      },
      `min(max((ih-${cropHeight})*0.28,0),ih-${cropHeight})`,
    );

    const xExpr = escapeFfmpegExpr(xExprRaw);
    const yExpr = escapeFfmpegExpr(yExprRaw);

    return {
      cropExpr: `crop=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT}:${xExpr}:${yExpr}`,
      wideIntervals,
    };
  } catch (error) {
    console.log('[smart-reframe]', {
      clipId: opts.debugClipId ?? null,
      candidateId: opts.debugCandidateId ?? null,
      enabled: true,
      backendScript: resolveSmartReframeScript(),
      smartCropReturnedPoints: false,
      jsonSaved: false,
      fallbackReason: error instanceof Error ? error.message : 'unknown_error',
    });
    return {};
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function floorEven(value: number) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function buildSplitStackFilter(
  opts: RenderOpts,
  layout: SplitStackLayout,
  includeCaptions: boolean,
  escapedPath?: string,
  captionPath?: string,
) {
  const seamHeight = 16;
  const paneHeight = Math.floor((layout.outputHeight - seamHeight) / 2);
  const paneAspect = layout.outputWidth / paneHeight;
  const cropWidth = floorEven(Math.min(layout.sourceW, layout.sourceH * paneAspect));
  const paneSourceHeight = floorEven(Math.min(layout.sourceH, cropWidth / paneAspect));
  const topCenterX = layout.topBox.cx ?? (layout.topBox.x + layout.topBox.w / 2);
  const bottomCenterX = layout.bottomBox.cx ?? (layout.bottomBox.x + layout.bottomBox.w / 2);
  const topCropX = clamp(topCenterX - cropWidth / 2, 0, layout.sourceW - cropWidth);
  const bottomCropX = clamp(bottomCenterX - cropWidth / 2, 0, layout.sourceW - cropWidth);

  const topCropY = clamp((layout.topBox.y + layout.topBox.h * 0.18) - paneSourceHeight * 0.42, 0, layout.sourceH - paneSourceHeight);
  const bottomCropY = clamp((layout.bottomBox.y + layout.bottomBox.h * 0.18) - paneSourceHeight * 0.42, 0, layout.sourceH - paneSourceHeight);

  const filterParts = [
    `[0:v]split=2[topsrc][bottomsrc]`,
    `[topsrc]crop=${Math.round(cropWidth)}:${Math.round(paneSourceHeight)}:${Math.round(topCropX)}:${Math.round(topCropY)},scale=${layout.outputWidth}:${paneHeight}:flags=${HIGH_QUALITY_SCALE_FLAGS}[topv]`,
    `[bottomsrc]crop=${Math.round(cropWidth)}:${Math.round(paneSourceHeight)}:${Math.round(bottomCropX)}:${Math.round(bottomCropY)},scale=${layout.outputWidth}:${paneHeight}:flags=${HIGH_QUALITY_SCALE_FLAGS}[bottomv]`,
    `color=c=black:s=${layout.outputWidth}x${layout.outputHeight}:d=1[base]`,
    `[base][topv]overlay=0:0[tmp1]`,
    `[tmp1][bottomv]overlay=0:${paneHeight + seamHeight}[tmp2]`,
    `[tmp2]drawbox=x=0:y=${paneHeight}:w=${layout.outputWidth}:h=${seamHeight}:color=black@0.96:t=fill[tmpDivider]`,
    `[tmpDivider]drawbox=x=0:y=${paneHeight + Math.floor(seamHeight / 2) - 1}:w=${layout.outputWidth}:h=2:color=white@0.20:t=fill[tmp3]`,
  ];

  let videoLabel = 'tmp3';

  filterParts.push(`[${videoLabel}]${SHARPEN_AFTER_UPSCALE_FILTER}[tmpSharp]`);
  videoLabel = 'tmpSharp';

  if (opts.hookTextEnabled !== false && opts.hookText && opts.hookText.trim()) {
    filterParts.push(`[${videoLabel}]${buildHookFilter(opts)}[tmpHook]`);
    videoLabel = 'tmpHook';
  }

  if (includeCaptions && escapedPath) {
    const fontsDirOption = captionFontsDirOption();
    const isAssInput = (captionPath ?? '').toLowerCase().endsWith('.ass');
    if (isAssInput) {
      filterParts.push(`[${videoLabel}]subtitles=filename='${escapedPath}'${fontsDirOption}[outv]`);
    } else {
      const style = escapeForceStyleForFilter([
        'FontName=Arial Black',
        'FontSize=108',
        'PrimaryColour=&H00FFFFFF',
        'SecondaryColour=&H005AF421',
        'OutlineColour=&H00000000',
        'BorderStyle=1',
        'Outline=11',
        'Shadow=2',
        'Bold=1',
        'ScaleX=106',
        'ScaleY=110',
        `MarginV=${Math.round(layout.outputHeight * 0.42)}`,
        'Alignment=2',
      ].join(','));
      filterParts.push(`[${videoLabel}]subtitles=filename='${escapedPath}'${fontsDirOption}:force_style='${style}'[outv]`);
    }
  } else {
    filterParts.push(`[${videoLabel}]copy[outv]`);
  }

  return filterParts.join(';');
}

function buildCropFilter(opts: RenderOpts, smartCropExpr?: string) {
  const mode = opts.reframeMode ?? 'off';
  const enabled = opts.autoReframe !== false && mode !== 'off';
  const preset = opts.reframePreset ?? 'auto';
  const framingMode = opts.framingMode ?? 'auto';
  const outputHeight = resolveOutputHeight();
  const outputWidth = resolveOutputWidth(outputHeight);
  const cropWidth = VERTICAL_EXPORT_WIDTH;
  const cropHeight = VERTICAL_EXPORT_HEIGHT;

  if (framingMode === 'manual') {
    const zoom = clamp(Number(opts.zoom ?? 1), 1, 2.4);
    const manualCropWidth = floorEven(clamp(Math.round(outputWidth / zoom), 360, outputWidth));
    const manualCropHeight = floorEven(clamp(Math.round(outputHeight / zoom), 640, outputHeight));
    const x = clamp(Number(opts.cropX ?? 0.5), 0, 1);
    const y = clamp(Number(opts.cropY ?? 0.34), 0, 1);
    return `crop=${manualCropWidth}:${manualCropHeight}:(iw-${manualCropWidth})*${x.toFixed(4)}:(ih-${manualCropHeight})*${y.toFixed(4)}`;
  }

  if (framingMode === 'center') {
    return `crop=${cropWidth}:${cropHeight}:(iw-${cropWidth})/2:min(max((ih-${cropHeight})*0.34,0),ih-${cropHeight})`;
  }

  if (!enabled) {
    console.log('[smart-reframe-fallback]', { reason: 'auto_reframe_disabled', mode, cropWidth, cropHeight });
    return `crop=${cropWidth}:${cropHeight}`;
  }
  if (mode === 'smart' && smartCropExpr) return smartCropExpr;
  if (mode === 'smart' && !smartCropExpr) {
    console.log('[smart-reframe-fallback]', { reason: 'smart_mode_without_crop_expr', mode, cropWidth, cropHeight });
  }

  const xExpr = preset === 'left'
    ? `max((iw-${cropWidth})*0.18,0)`
    : preset === 'right'
      ? `min((iw-${cropWidth})*0.82,iw-${cropWidth})`
      : `(iw-${cropWidth})/2`;
  const yExpr = escapeFfmpegExpr(`min(max((ih-${cropHeight})*0.24,0),ih-${cropHeight})`);
  return `crop=${cropWidth}:${cropHeight}:${xExpr}:${yExpr}`;
}

function shouldUseSafeFitFallback(_opts: RenderOpts, _smartCropExpr?: string) {
  return false;
}

function resolveOutputHeight() {
  return VERTICAL_EXPORT_HEIGHT;
}

function resolveOutputWidth(_outputHeight: number) {
  return VERTICAL_EXPORT_WIDTH;
}

function wrapHookTextForDrawtext(hookText: string) {
  const words = hookText.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    const next = [...current, word].join(' ');
    const shouldWrap = current.length > 0 && (next.length > 24 || current.length >= 5);

    if (shouldWrap) {
      lines.push(current.join(' '));
      current = [];
    }

    if (lines.length >= 2) break;
    current.push(word);
  }

  if (current.length && lines.length < 2) lines.push(current.join(' '));
  return lines.join('\n') || 'Top Moment';
}

function escapeHookAssText(text: string) {
  return text
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .replace(/\r?\n/g, '\\N')
    .trim();
}

function buildRoundedHookShape(x: number, y: number, width: number, height: number, radius: number) {
  const right = x + width;
  const bottom = y + height;
  const k = Math.round(radius * 0.55);
  return [
    `m ${x + radius} ${y}`,
    `l ${right - radius} ${y}`,
    `b ${right - k} ${y} ${right} ${y + k} ${right} ${y + radius}`,
    `l ${right} ${bottom - radius}`,
    `b ${right} ${bottom - k} ${right - k} ${bottom} ${right - radius} ${bottom}`,
    `l ${x + radius} ${bottom}`,
    `b ${x + k} ${bottom} ${x} ${bottom - k} ${x} ${bottom - radius}`,
    `l ${x} ${y + radius}`,
    `b ${x} ${y + k} ${x + k} ${y} ${x + radius} ${y}`,
  ].join(' ');
}

function buildHookAss(hookText: string, placement: 'top' | 'middle' = 'top') {
  const lines = hookText.split('\n').filter(Boolean);
  const twoLine = lines.length > 1;
  const cardWidth = 780;
  const cardHeight = twoLine ? 180 : 132;
  const cardX = Math.round((VERTICAL_EXPORT_WIDTH - cardWidth) / 2);
  const topCardY = twoLine ? 72 : 84;
  const cardY = placement === 'middle'
    ? Math.round((VERTICAL_EXPORT_HEIGHT - cardHeight) / 2)
    : topCardY;
  const textY = cardY + Math.round(cardHeight / 2) + (twoLine ? 2 : 0);
  const textX = Math.round(VERTICAL_EXPORT_WIDTH / 2);
  const cardShape = buildRoundedHookShape(cardX, cardY, cardWidth, cardHeight, 30);
  const hookFontSize = twoLine ? 68 : 76;
  const text = escapeHookAssText(hookText);

  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${VERTICAL_EXPORT_WIDTH}
PlayResY: ${VERTICAL_EXPORT_HEIGHT}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: HookCard,Arial,1,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: HookText,Poppins ExtraBold,${hookFontSize},&H00000000,&H00000000,&H00303030,&H00000000,-1,0,0,0,100,100,0,0,1,1.4,0,5,70,70,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:04.50,HookCard,,0,0,0,,{\\an7\\pos(0,0)\\p1\\c&HFFFFFF&}${cardShape}
Dialogue: 1,0:00:00.00,0:00:04.50,HookText,,0,0,0,,{\\an5\\pos(${textX},${textY})}${text}
`;
}

function buildHookDrawtextFilter(hookText: string, hookTextFilePath?: string, placement: 'top' | 'middle' = 'top') {
  const wrapped = wrapHookTextForDrawtext(hookText);
  const source = hookTextFilePath
    ? `textfile='${escapeDrawtextPathForFilter(hookTextFilePath)}':reload=0`
    : `text='${escapeDrawtextText(wrapped)}'`;
  const bundledFontPath = path.join(/* turbopackIgnore: true */ process.cwd(), 'public', 'fonts', 'Poppins-ExtraBold.ttf');
  const fontSource = existsSync(bundledFontPath)
    ? `fontfile='${escapeDrawtextPathForFilter(bundledFontPath)}'`
    : "font='Arial Black'";
  return [
    `drawtext=${source}`,
    fontSource,
    'fontcolor=black',
    'fontsize=108',
    'box=1',
    'boxcolor=white',
    'boxborderw=38',
    'borderw=2',
    'bordercolor=black@0.28',
    'shadowx=0',
    'shadowy=0',
    'ft_load_flags=force_autohint',
    'line_spacing=14',
    'fix_bounds=1',
    'x=(w-text_w)/2',
    placement === 'middle' ? 'y=(h-text_h)/2' : 'y=74',
    drawtextBetween(0, 4.5),
  ].join(':');
}

function buildHookFilter(opts: RenderOpts) {
  if (opts.hookRenderMode !== 'drawtext' && opts.hookAssPath) {
    return `subtitles=filename='${escapeSubtitlesPathForFilter(opts.hookAssPath)}'${captionFontsDirOption()}`;
  }
  return buildHookDrawtextFilter(opts.hookText?.trim() ?? '', opts.hookTextFilePath, opts.hookPlacement);
}

function buildBaseVideoFilters(
  opts: RenderOpts,
  outputWidth: number,
  outputHeight: number,
  escapedMotionTransformPath?: string,
  smartCropExpr?: string,
) {
  const filters: string[] = [];
  const fitMode = opts.framingMode === 'fit';

  if (fitMode) {
    filters.push(`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease:flags=${HIGH_QUALITY_SCALE_FLAGS}`);
    filters.push(`pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2:black`);
    filters.push(SHARPEN_AFTER_UPSCALE_FILTER);
    filters.push('setsar=1');
    return filters;
  }

  filters.push(`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase:flags=${HIGH_QUALITY_SCALE_FLAGS}`);

  if (escapedMotionTransformPath) {
    filters.push(
      `vidstabtransform=input='${escapedMotionTransformPath}':smoothing=28:optzoom=0:interpol=bicubic`,
    );
  }

  filters.push(buildCropFilter(opts, smartCropExpr));
  filters.push(`scale=${outputWidth}:${outputHeight}:flags=${HIGH_QUALITY_SCALE_FLAGS}`);
  filters.push(SHARPEN_AFTER_UPSCALE_FILTER);
  filters.push('setsar=1');
  return filters;
}

function appendPresentationFilters(
  filterParts: string[],
  opts: RenderOpts,
  includeCaptions: boolean,
  escapedPath?: string,
  captionPath?: string,
) {
  if (opts.debugReframeOverlay) {
    filterParts.push(
      "drawbox=x=iw/2-6:y=0:w=12:h=ih:color=yellow@0.65:t=fill",
      "drawbox=x=0:y=ih*0.35:w=iw:h=6:color=cyan@0.55:t=fill",
      "drawbox=x=0:y=ih*0.45:w=iw:h=6:color=cyan@0.55:t=fill"
    );
  }

  if (opts.hookTextEnabled !== false && opts.hookText && opts.hookText.trim()) {
    filterParts.push(buildHookFilter(opts));
  }

  if (includeCaptions && escapedPath) {
    const fontsDirOption = captionFontsDirOption();
    const template = opts.captionTemplate ?? 'capcut';
    const captionFont = opts.captionFont ?? 'arial';

    const fontMap: Record<CaptionFont, string> = {
      arial: 'Arial',
      montserrat: 'Montserrat',
      impact: 'Impact',
      bangers: 'Bangers',
      anton: 'Anton',
      bebas: 'Bebas Neue',
      poppins: 'Poppins',
    };

    const styleMap: Record<CaptionTemplate, string[]> = {
      clean: [
        `FontName=${fontMap[captionFont]}`,
        'FontSize=12',
        'PrimaryColour=&H00FFFFFF',
        'OutlineColour=&H00303030',
        'BorderStyle=1',
        'Outline=2',
        'Shadow=0',
        'MarginV=64',
        'Alignment=2',
      ],
      bold: [
        `FontName=${fontMap[captionFont]}`,
        'FontSize=13',
        'PrimaryColour=&H00FFFFFF',
        'OutlineColour=&H00000000',
        'BorderStyle=1',
        'Outline=3',
        'Shadow=0',
        'MarginV=72',
        'Alignment=2',
      ],
      viral: [
        `FontName=${fontMap[captionFont]}`,
        'FontSize=14',
        'PrimaryColour=&H0000F5FF',
        'OutlineColour=&H00000000',
        'BorderStyle=1',
        'Outline=3',
        'Shadow=0',
        'MarginV=76',
        'Alignment=2',
      ],
      karaoke: [
        `FontName=${fontMap[captionFont]}`,
        'FontSize=15',
        'PrimaryColour=&H0000FFFF',
        'OutlineColour=&H00000000',
        'BorderStyle=1',
        'Outline=4',
        'Shadow=0',
        'Bold=1',
        'MarginV=78',
        'Alignment=2',
      ],
      cinematic: [
        `FontName=${fontMap[captionFont]}`,
        'FontSize=10',
        'PrimaryColour=&H00F0F0F0',
        'OutlineColour=&H00202020',
        'BorderStyle=1',
        'Outline=1',
        'Shadow=1',
        'Spacing=0.2',
        'MarginV=54',
        'Alignment=2',
      ],
      rage: [
        `FontName=${fontMap[captionFont]}`,
        'FontSize=16',
        'PrimaryColour=&H004C4CFF',
        'OutlineColour=&H00000000',
        'BorderStyle=1',
        'Outline=5',
        'Shadow=0',
        'Bold=1',
        'MarginV=82',
        'Alignment=2',
      ],
      minimal: [
        `FontName=${fontMap[captionFont]}`,
        'FontSize=9',
        'PrimaryColour=&H00FFFFFF',
        'OutlineColour=&H002B2B2B',
        'BorderStyle=1',
        'Outline=1',
        'Shadow=0',
        'MarginV=46',
        'Alignment=2',
      ],
      capcut: [
        'FontName=Arial Black',
        'FontSize=124',
        'PrimaryColour=&H00FFFFFF',
        'SecondaryColour=&H005AF421',
        'OutlineColour=&H00000000',
        'BorderStyle=1',
        'Outline=11',
        'Shadow=2',
        'Bold=1',
        'Spacing=0',
        'ScaleX=106',
        'ScaleY=110',
        'MarginV=380',
        'Alignment=2',
      ],
    };
    const isAssInput = (captionPath ?? '').toLowerCase().endsWith('.ass');
    if (isAssInput) {
      // ASS files carry their own styles and inline word highlights; avoid force_style overrides.
      filterParts.push(`subtitles=filename='${escapedPath}'${fontsDirOption}`);
    } else {
      const style = escapeForceStyleForFilter(styleMap[template].join(','));
      filterParts.push(`subtitles=filename='${escapedPath}'${fontsDirOption}:force_style='${style}'`);
    }
  }

  return filterParts;
}

function buildFilter(
  opts: RenderOpts,
  includeCaptions: boolean,
  escapedPath?: string,
  escapedMotionTransformPath?: string,
  captionPath?: string,
  smartCropExpr?: string,
) {
  const outputHeight = resolveOutputHeight();
  const outputWidth = resolveOutputWidth(outputHeight);
  const safeFitFallback = shouldUseSafeFitFallback(opts, smartCropExpr);
  const filterParts = buildBaseVideoFilters(opts, outputWidth, outputHeight, escapedMotionTransformPath, smartCropExpr);

  if (safeFitFallback) {
    console.log('[smart-reframe-fallback]', {
      clipId: opts.debugClipId ?? null,
      candidateId: opts.debugCandidateId ?? null,
      reason: 'smart_tracker_unavailable_safe_full_frame',
      outputWidth,
      outputHeight,
    });
  }

  return appendPresentationFilters(filterParts, opts, includeCaptions, escapedPath, captionPath).join(',');
}

function buildAdaptiveWideFilter(
  opts: RenderOpts,
  wideIntervals: FramingInterval[],
  includeCaptions: boolean,
  escapedPath?: string,
  escapedMotionTransformPath?: string,
  captionPath?: string,
  smartCropExpr?: string,
) {
  const outputHeight = resolveOutputHeight();
  const outputWidth = resolveOutputWidth(outputHeight);
  const closeFilters = buildBaseVideoFilters(opts, outputWidth, outputHeight, escapedMotionTransformPath, smartCropExpr);
  const enableExpr = wideIntervals
    .map((interval) => `between(t,${interval.start.toFixed(3)},${interval.end.toFixed(3)})`)
    .join('+');

  const graph = [
    '[0:v]split=3[closein][widebgin][widefgin]',
    `[closein]${closeFilters.join(',')}[close]`,
    `[widebgin]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase:flags=${HIGH_QUALITY_SCALE_FLAGS},crop=${outputWidth}:${outputHeight},boxblur=24:2[widebg]`,
    `[widefgin]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease:flags=${HIGH_QUALITY_SCALE_FLAGS}[widefg]`,
    `[widebg][widefg]overlay=(W-w)/2:(H-h)/2:format=auto[wide]`,
    `[close][wide]overlay=0:0:enable='${enableExpr}'[adaptive]`,
  ];
  const presentationFilters = appendPresentationFilters([], opts, includeCaptions, escapedPath, captionPath);
  graph.push(presentationFilters.length
    ? `[adaptive]${presentationFilters.join(',')}[outv]`
    : '[adaptive]null[outv]');
  return graph.join(';');
}

function buildInterpolatedSegmentExpr(
  segment: ReframeTimelineSegment,
  pick: (point: ReframeTimelinePoint) => number,
  fallback: number,
) {
  const points = segment.points.filter((point) => point.t >= segment.start - 0.001 && point.t <= segment.end + 0.001);
  if (!points.length) return fallback.toFixed(3);
  let expression = pick(points[points.length - 1]).toFixed(3);
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const first = points[index];
    const second = points[index + 1];
    const localStart = Math.max(0, first.t - segment.start);
    const localEnd = Math.max(localStart + 0.001, second.t - segment.start);
    const firstValue = pick(first);
    const secondValue = pick(second);
    const interpolated = `${firstValue.toFixed(3)}+(${(secondValue - firstValue).toFixed(3)})*(t-${localStart.toFixed(3)})/${(localEnd - localStart).toFixed(3)}`;
    expression = `if(between(t,${localStart.toFixed(3)},${localEnd.toFixed(3)}),${interpolated},${expression})`;
  }
  return expression;
}

function buildTimelineStackPane(
  inputLabel: string,
  outputLabel: string,
  box: SubjectBox,
  sourceW: number,
  sourceH: number,
  paneHeight: number,
) {
  const paneAspect = VERTICAL_EXPORT_WIDTH / paneHeight;
  const desiredCropHeight = clamp(box.h * 3.2, sourceH * 0.72, sourceH);
  const cropHeight = floorEven(Math.min(sourceH, desiredCropHeight));
  const cropWidth = floorEven(Math.min(sourceW, cropHeight * paneAspect));
  const faceCx = box.cx ?? (box.x + box.w / 2);
  const faceCy = box.cy ?? (box.y + box.h / 2);
  const cropX = floorEven(clamp(faceCx - cropWidth / 2, 0, Math.max(0, sourceW - cropWidth)));
  const cropY = floorEven(clamp(faceCy - cropHeight * 0.40, 0, Math.max(0, sourceH - cropHeight)));
  return `${inputLabel}crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=${VERTICAL_EXPORT_WIDTH}:${paneHeight}:flags=${HIGH_QUALITY_SCALE_FLAGS},setsar=1${outputLabel}`;
}

function buildTimelineGridPane(
  inputLabel: string,
  outputLabel: string,
  box: SubjectBox,
  sourceW: number,
  sourceH: number,
  paneWidth: number,
  paneHeight: number,
) {
  const paneAspect = paneWidth / paneHeight;
  const faceCx = box.cx ?? (box.x + box.w / 2);
  const faceCy = box.cy ?? (box.y + box.h / 2);
  // Include head and shoulders, then expand as needed to match the pane.
  let cropHeight = clamp(box.h * 3.1, sourceH * 0.42, sourceH);
  let cropWidth = cropHeight * paneAspect;
  if (cropWidth > sourceW) {
    cropWidth = sourceW;
    cropHeight = cropWidth / paneAspect;
  }
  cropWidth = floorEven(cropWidth);
  cropHeight = floorEven(Math.min(sourceH, cropHeight));
  const cropX = floorEven(clamp(faceCx - cropWidth / 2, 0, Math.max(0, sourceW - cropWidth)));
  const cropY = floorEven(clamp(faceCy - cropHeight * 0.38, 0, Math.max(0, sourceH - cropHeight)));
  return `${inputLabel}crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=${paneWidth}:${paneHeight}:flags=${HIGH_QUALITY_SCALE_FLAGS},${SHARPEN_AFTER_UPSCALE_FILTER},setsar=1${outputLabel}`;
}

function buildTimelineGrid(
  base: string,
  normalizedOutput: string,
  index: number,
  segment: ReframeTimelineSegment,
  sourceW: number,
  sourceH: number,
) {
  const required = segment.gridTemplate === 'grid_4' ? 4 : 3;
  const subjects = (segment.subjects ?? []).slice(0, required);
  if (subjects.length < required) return buildLargeSafeWideContext(base, normalizedOutput, index);
  const graph: string[] = [`${base},split=${required}${subjects.map((_, subjectIndex) => `[grid${index}in${subjectIndex}]`).join('')}`];

  if (segment.gridTemplate === 'hero_3') {
    graph.push(buildTimelineGridPane(`[grid${index}in0]`, `[grid${index}hero]`, subjects[0].box, sourceW, sourceH, VERTICAL_EXPORT_WIDTH, 960));
    graph.push(buildTimelineGridPane(`[grid${index}in1]`, `[grid${index}support1]`, subjects[1].box, sourceW, sourceH, 540, 960));
    graph.push(buildTimelineGridPane(`[grid${index}in2]`, `[grid${index}support2]`, subjects[2].box, sourceW, sourceH, 540, 960));
    graph.push(`[grid${index}support1][grid${index}support2]hstack=inputs=2[grid${index}bottom]`);
    graph.push(`[grid${index}hero][grid${index}bottom]vstack=inputs=2,setsar=1,fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`);
    return graph;
  }

  if (segment.gridTemplate === 'grid_4') {
    subjects.forEach((subject, subjectIndex) => graph.push(buildTimelineGridPane(`[grid${index}in${subjectIndex}]`, `[grid${index}pane${subjectIndex}]`, subject.box, sourceW, sourceH, 540, 960)));
    graph.push(`[grid${index}pane0][grid${index}pane1]hstack=inputs=2[grid${index}row0]`);
    graph.push(`[grid${index}pane2][grid${index}pane3]hstack=inputs=2[grid${index}row1]`);
    graph.push(`[grid${index}row0][grid${index}row1]vstack=inputs=2,setsar=1,fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`);
    return graph;
  }

  const paneHeight = 640;
  subjects.forEach((subject, subjectIndex) => graph.push(buildTimelineGridPane(`[grid${index}in${subjectIndex}]`, `[grid${index}pane${subjectIndex}]`, subject.box, sourceW, sourceH, VERTICAL_EXPORT_WIDTH, paneHeight)));
  graph.push(`[grid${index}pane0][grid${index}pane1][grid${index}pane2]vstack=inputs=3,setsar=1,fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`);
  return graph;
}

function buildCropToFillContext(
  inputLabel: string,
  outputLabel: string,
  sourceW: number,
  sourceH: number,
) {
  const cropHeight = floorEven(sourceH);
  const cropWidth = floorEven(Math.min(sourceW, cropHeight * VERTICAL_EXPORT_WIDTH / VERTICAL_EXPORT_HEIGHT));
  const cropX = floorEven(Math.max(0, (sourceW - cropWidth) / 2));
  return `${inputLabel}crop=${cropWidth}:${cropHeight}:${cropX}:0,scale=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT}:flags=${HIGH_QUALITY_SCALE_FLAGS},${SHARPEN_AFTER_UPSCALE_FILTER},setsar=1${outputLabel}`;
}

function buildLargeSafeWideContext(
  base: string,
  normalizedOutput: string,
  index: number,
) {
  // Low-confidence fallback: preserve context, but make the foreground occupy
  // 85% of the vertical canvas. The old fit path occupied only ~32%.
  const foregroundHeight = floorEven(VERTICAL_EXPORT_HEIGHT * 0.85);
  return [
    `${base},split=2[safewidebg${index}][safewidefg${index}]`,
    `[safewidebg${index}]scale=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT}:force_original_aspect_ratio=increase:flags=${HIGH_QUALITY_SCALE_FLAGS},crop=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT},boxblur=24:2[safewidebgready${index}]`,
    `[safewidefg${index}]scale=-2:${foregroundHeight}:flags=${HIGH_QUALITY_SCALE_FLAGS},crop=${VERTICAL_EXPORT_WIDTH}:${foregroundHeight}:(iw-${VERTICAL_EXPORT_WIDTH})/2:0[safewidefgready${index}]`,
    `[safewidebgready${index}][safewidefgready${index}]overlay=0:(H-h)/2:format=auto,setsar=1,fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`,
  ];
}

function buildTimedReframeFilter(
  opts: RenderOpts,
  timeline: ReframeTimelineSegment[],
  sourceW: number,
  sourceH: number,
  includeCaptions: boolean,
  escapedPath?: string,
  captionPath?: string,
) {
  const segments = timeline.filter((segment) => segment.end - segment.start >= 0.05);
  if (!segments.length) throw new Error('Timed reframe plan has no renderable segments');
  const graph: string[] = [`[0:v]split=${segments.length}${segments.map((_, index) => `[timeline${index}]`).join('')}`];
  const outputs: string[] = [];

  segments.forEach((segment, index) => {
    const base = `[timeline${index}]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS`;
    const normalizedOutput = `[segment${index}]`;

    if (segment.mode === 'source_vertical') {
      graph.push(`${base},scale=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT}:force_original_aspect_ratio=decrease:flags=${HIGH_QUALITY_SCALE_FLAGS},pad=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`);
    } else if (segment.mode === 'grid' && sourceW > 0 && sourceH > 0) {
      graph.push(...buildTimelineGrid(base, normalizedOutput, index, segment, sourceW, sourceH));
    } else if ((segment.mode === 'stacked' || (segment.mode === 'wide_context' && segment.wideKind === 'two_person')) && segment.topBox && segment.bottomBox && sourceW > 0 && sourceH > 0) {
      const dividerHeight = 16;
      const paneHeight = Math.floor((VERTICAL_EXPORT_HEIGHT - dividerHeight) / 2);
      graph.push(`${base},split=2[stacktop${index}][stackbottom${index}]`);
      graph.push(buildTimelineStackPane(`[stacktop${index}]`, `[stacktopready${index}]`, segment.topBox, sourceW, sourceH, paneHeight));
      graph.push(buildTimelineStackPane(`[stackbottom${index}]`, `[stackbottomready${index}]`, segment.bottomBox, sourceW, sourceH, paneHeight));
      graph.push(`color=c=white@0.82:s=${VERTICAL_EXPORT_WIDTH}x${dividerHeight}:d=${(segment.end - segment.start).toFixed(3)}[divider${index}]`);
      graph.push(`[stacktopready${index}][divider${index}][stackbottomready${index}]vstack=inputs=3,setsar=1,fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`);
    } else if (segment.mode === 'wide_context' && segment.wideKind === 'broll' && sourceW > 0 && sourceH > 0) {
      graph.push(`${buildCropToFillContext(`${base},`, '', sourceW, sourceH)},fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`);
    } else if (segment.mode === 'wide_context') {
      graph.push(...buildLargeSafeWideContext(base, normalizedOutput, index));
    } else {
      const firstPoint = segment.points[0];
      if (!firstPoint) {
        graph.push(...buildLargeSafeWideContext(base, normalizedOutput, index));
        outputs.push(normalizedOutput);
        return;
      }
      const cropWidth = floorEven(firstPoint?.cropW ?? Math.min(sourceW, sourceH * 9 / 16));
      const cropHeight = floorEven(firstPoint?.cropH ?? sourceH);
      const fallbackX = firstPoint?.cropX ?? Math.max(0, (sourceW - cropWidth) / 2);
      const fallbackY = firstPoint?.cropY ?? 0;
      const xExpr = escapeFfmpegExpr(buildInterpolatedSegmentExpr(segment, (point) => point.cropX, fallbackX));
      const yExpr = escapeFfmpegExpr(buildInterpolatedSegmentExpr(segment, (point) => point.cropY, fallbackY));
      graph.push(`${base},crop=${cropWidth}:${cropHeight}:${xExpr}:${yExpr},scale=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT}:flags=${HIGH_QUALITY_SCALE_FLAGS},${SHARPEN_AFTER_UPSCALE_FILTER},setsar=1,fps=30,format=yuv420p,settb=AVTB${normalizedOutput}`);
    }
    outputs.push(normalizedOutput);
  });

  graph.push(`${outputs.join('')}concat=n=${outputs.length}:v=1:a=0[timelineout]`);
  const presentationFilters = appendPresentationFilters([], opts, includeCaptions, escapedPath, captionPath);
  graph.push(presentationFilters.length
    ? `[timelineout]${presentationFilters.join(',')}[outv]`
    : '[timelineout]null[outv]');
  return graph.join(';');
}

export async function renderVerticalClip(opts: RenderOpts) {
  const outputHeight = resolveOutputHeight();
  const outputWidth = resolveOutputWidth(outputHeight);
  const envMode = ((process.env.AUTO_REFRAME_MODE || 'basic').trim().toLowerCase() as ReframeMode);
  const requestedMode: ReframeMode = opts.reframeMode ?? (envMode === 'off' ? 'off' : 'smart');
  const effectiveMode: ReframeMode = opts.autoReframe === false || requestedMode === 'off' ? 'off' : 'smart';
  console.log('[render] reframe-mode', {
    clipId: opts.debugClipId ?? null,
    alignmentVersion: RENDER_ALIGNMENT_VERSION,
    requestedMode: opts.reframeMode ?? null,
    envMode,
    effectiveMode,
    autoReframeRequested: opts.autoReframe ?? null,
    autoReframeEnabled: opts.autoReframe ?? process.env.AUTO_REFRAME_ENABLED !== 'false',
    smartScript: resolveSmartReframeScript(),
    smartPython: resolveSmartReframePython(),
  });
  let sourceColorMetadata: SourceColorMetadata | null = null;
  try {
    const sourceInfo = await probeInputVideoForRender(opts.inputPath);
    sourceColorMetadata = {
      colorSpace: sourceInfo.colorSpace,
      colorTransfer: sourceInfo.colorTransfer,
      colorPrimaries: sourceInfo.colorPrimaries,
    };
    const estimatedVerticalCropUpscale = sourceInfo.height && sourceInfo.height > 0
      ? Number((outputHeight / sourceInfo.height).toFixed(3))
      : null;
    console.log('[render] source-quality', {
      clipId: opts.debugClipId ?? null,
      inputPath: opts.inputPath,
      outputWidth,
      outputHeight,
      sourceWidth: sourceInfo.width,
      sourceHeight: sourceInfo.height,
      sourceCodec: sourceInfo.codec,
      sourceFps: sourceInfo.fps,
      sourceVideoBitrate: sourceInfo.videoBitrate,
      sourceContainerBitrate: sourceInfo.containerBitrate,
      sourceDuration: sourceInfo.duration,
      sourceSize: sourceInfo.size,
      sourceColorSpace: sourceInfo.colorSpace,
      sourceColorTransfer: sourceInfo.colorTransfer,
      sourceColorPrimaries: sourceInfo.colorPrimaries,
      estimatedVerticalCropUpscale,
      sourceBelowHd: Boolean(sourceInfo.height && sourceInfo.height < 1080),
    });
  } catch (error) {
    console.warn('[render] source-quality-probe-failed', {
      clipId: opts.debugClipId ?? null,
      error: error instanceof Error ? error.message : 'Unknown source probe error',
    });
  }
  const effectiveOpts: RenderOpts = {
    ...opts,
    autoReframe: opts.autoReframe ?? process.env.AUTO_REFRAME_ENABLED !== 'false',
    reframeMode: effectiveMode,
    // Debug overlays must be explicitly requested by a debug-only caller. An
    // environment variable can never burn guides into a customer export.
    debugReframeOverlay: opts.debugReframeOverlay === true,
  };

  let escapedPath: string | undefined;
  let canUseCaptions = false;
  let escapedMotionTransformPath: string | undefined;
  const smartReframe = await maybeBuildSmartCropExpression(effectiveOpts);
  const smartCropExpr = smartReframe.cropExpr;
  const splitStackLayout = smartReframe.layout;
  const adaptiveWideIntervals = smartReframe.wideIntervals ?? [];
  const reframeTimeline = smartReframe.timeline ?? [];

  if (
    effectiveMode === 'smart'
    && reframeTimeline.length === 0
    && !splitStackLayout
    && adaptiveWideIntervals.length === 0
    && !smartCropExpr
  ) {
    // Never publish a center crop when subject-aware analysis failed. On a
    // two-person source that fallback lands on the divider and cuts both
    // faces in half. Retrying/failing the export is safer than shipping a
    // composition we already know is invalid.
    throw new Error('smart_reframe_analysis_unavailable');
  }

  if (effectiveOpts.captionsEnabled !== false && effectiveOpts.srtPath) {
    try {
      await access(effectiveOpts.srtPath);
      escapedPath = escapeSubtitlesPathForFilter(effectiveOpts.srtPath);
      canUseCaptions = true;
    } catch {
      canUseCaptions = false;
    }
  }

  if (effectiveOpts.motionTracking !== false) {
    try {
      const transformPath = `${opts.outputPath}.trf`;
      escapedMotionTransformPath = escapeSubtitlesPathForFilter(transformPath);

      await runFfmpeg([
        '-y',
        '-ss',
        String(opts.startSec),
        '-to',
        String(opts.endSec),
        '-i',
        opts.inputPath,
        '-vf',
        `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase:flags=${HIGH_QUALITY_SCALE_FLAGS},vidstabdetect=shakiness=7:accuracy=15:result='${escapedMotionTransformPath}'`,
        '-f',
        'null',
        '-',
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const motionFilterMissing = /No such filter: 'vidstabdetect'|Filter not found/i.test(msg);
      if (motionFilterMissing) {
        escapedMotionTransformPath = undefined;
      } else {
        // Non-fatal: continue rendering without motion tracking if detect pass fails.
        escapedMotionTransformPath = undefined;
      }
    }
  }

  const defaultEncoder = process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264';
  const configuredEncoder = (process.env.FFMPEG_VIDEO_ENCODER || defaultEncoder).trim();
  const configuredPreset = (opts.fastRender ? process.env.FFMPEG_EDIT_X264_PRESET || 'veryfast' : process.env.FFMPEG_X264_PRESET || 'medium').trim();
  const allowOversizedExports = process.env.FFMPEG_ALLOW_OVERSIZED_EXPORTS === 'true';
  const configuredCrf = (allowOversizedExports ? process.env.FFMPEG_X264_CRF || DEFAULT_X264_CRF : DEFAULT_X264_CRF).trim();
  const configuredX264Maxrate = (allowOversizedExports ? process.env.FFMPEG_X264_MAXRATE || DEFAULT_X264_MAXRATE : DEFAULT_X264_MAXRATE).trim();
  const configuredX264Bufsize = (allowOversizedExports ? process.env.FFMPEG_X264_BUFSIZE || DEFAULT_X264_BUFSIZE : DEFAULT_X264_BUFSIZE).trim();

  const debugClipId = (effectiveOpts.debugClipId ?? effectiveOpts.outputPath.split('/').pop()?.replace(/\.mp4$/, '')) || 'unknown';
  if (effectiveOpts.hookTextEnabled !== false && effectiveOpts.hookText?.trim()) {
    const wrappedHookText = wrapHookTextForDrawtext(effectiveOpts.hookText);
    const hookFilePath = `${effectiveOpts.outputPath}.hook.txt`;
    await writeFile(hookFilePath, wrappedHookText, 'utf8');
    effectiveOpts.hookTextFilePath = hookFilePath;
    if ((effectiveOpts.hookRenderMode ?? 'ass') === 'ass') {
      const hookAssPath = `${effectiveOpts.outputPath}.hook.ass`;
      await writeFile(hookAssPath, buildHookAss(wrappedHookText, effectiveOpts.hookPlacement), 'utf8');
      effectiveOpts.hookAssPath = hookAssPath;
    }
  }

  const buildArgs = (includeCaptions: boolean, encoder = configuredEncoder) => {
    const common = [
      '-y',
      '-ss',
      String(effectiveOpts.startSec),
      '-to',
      String(effectiveOpts.endSec),
      '-i',
      effectiveOpts.inputPath,
    ];

    if (reframeTimeline.length > 0) {
      common.push(
        '-filter_complex',
        buildTimedReframeFilter(
          effectiveOpts,
          reframeTimeline,
          Number(smartReframe.sourceW ?? 0),
          Number(smartReframe.sourceH ?? 0),
          includeCaptions,
          escapedPath,
          effectiveOpts.srtPath,
        ),
        '-map',
        '[outv]',
        '-map',
        '0:a?',
      );
    } else if (splitStackLayout) {
      common.push(
        '-filter_complex',
        buildSplitStackFilter(effectiveOpts, splitStackLayout, includeCaptions, escapedPath, effectiveOpts.srtPath),
        '-map',
        '[outv]',
        '-map',
        '0:a?',
      );
    } else if (adaptiveWideIntervals.length > 0) {
      common.push(
        '-filter_complex',
        buildAdaptiveWideFilter(
          effectiveOpts,
          adaptiveWideIntervals,
          includeCaptions,
          escapedPath,
          escapedMotionTransformPath,
          effectiveOpts.srtPath,
          smartCropExpr,
        ),
        '-map',
        '[outv]',
        '-map',
        '0:a?',
      );
    } else {
      common.push(
        '-vf',
        buildFilter(effectiveOpts, includeCaptions, escapedPath, escapedMotionTransformPath, effectiveOpts.srtPath, smartCropExpr),
      );
    }

    const configuredOutputFps = Number(process.env.FFMPEG_OUTPUT_FPS ?? 0);
    common.push(...buildRenderOutputArgs({
      encoder,
      preset: configuredPreset,
      crf: configuredCrf,
      x264Maxrate: configuredX264Maxrate,
      x264Bufsize: configuredX264Bufsize,
      hardwareBitrate: allowOversizedExports ? process.env.FFMPEG_HW_VIDEO_BITRATE || DEFAULT_HW_VIDEO_BITRATE : DEFAULT_HW_VIDEO_BITRATE,
      hardwareMaxrate: allowOversizedExports ? process.env.FFMPEG_HW_MAXRATE || DEFAULT_HW_MAXRATE : DEFAULT_HW_MAXRATE,
      hardwareBufsize: allowOversizedExports ? process.env.FFMPEG_HW_BUFSIZE || DEFAULT_HW_BUFSIZE : DEFAULT_HW_BUFSIZE,
      outputFps: configuredOutputFps,
      sourceColor: sourceColorMetadata,
      volume: Number(effectiveOpts.volume ?? 1),
      outputPath: effectiveOpts.outputPath,
    }));

    return common;
  };

  try {
    console.log('[render] output-path', { clipId: debugClipId, localMp4Path: effectiveOpts.outputPath, inputPath: effectiveOpts.inputPath, startSec: effectiveOpts.startSec, endSec: effectiveOpts.endSec, smartCropExpr: smartCropExpr ?? null, splitStack: Boolean(splitStackLayout), timelineSegments: reframeTimeline.length, adaptiveWideIntervals });
    await runFfmpeg(buildArgs(canUseCaptions), { clipId: debugClipId, outputPath: effectiveOpts.outputPath });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const subtitlesUnavailable = /No such filter: 'subtitles'/i.test(msg);
    const textOverlayFailed = /drawtext|Cannot find a valid font|Error initializing filter|No such filter: '[0-9.]+|No such filter: 'between|Filter not found/i.test(msg);
    const encoderUnavailable = /Unknown encoder|Error while opening encoder|Encoder .* not found|Invalid argument/i.test(msg);
    const smartLayoutFailed = effectiveMode === 'smart'
      && Boolean(smartCropExpr || splitStackLayout || adaptiveWideIntervals.length || reframeTimeline.length)
      && /crop|filtergraph|Error reinitializing filters|Failed to inject frame|Error while filtering|Invalid too big or non positive size/i.test(msg);

    if (configuredEncoder !== 'libx264' && encoderUnavailable) {
      // Server-safe fallback: if requested hardware encoder is unavailable on this host,
      // transparently retry with libx264 so customer renders still succeed.
      await runFfmpeg(buildArgs(canUseCaptions, 'libx264'), { clipId: debugClipId, outputPath: effectiveOpts.outputPath });
      return;
    }

    if (subtitlesUnavailable && effectiveOpts.hookAssPath && effectiveOpts.hookRenderMode !== 'drawtext') {
      console.warn('[render] hook-ass-fallback', { clipId: debugClipId, reason: msg.split('\n').slice(-4).join(' | ') });
      await renderVerticalClip({
        ...effectiveOpts,
        hookRenderMode: 'drawtext',
        hookAssPath: undefined,
      });
      return;
    }

    if (effectiveOpts.hookTextEnabled !== false && effectiveOpts.hookText && textOverlayFailed) {
      console.warn('[render] hook-overlay-fallback', { clipId: debugClipId, reason: msg.split('\n').slice(-4).join(' | ') });
      await renderVerticalClip({
        ...effectiveOpts,
        hookTextEnabled: false,
      });
      return;
    }

    if (smartLayoutFailed) {
      console.warn('[render] smart-layout-safe-fallback', {
        clipId: debugClipId,
        reason: msg.split('\n').slice(-6).join(' | '),
      });
      await renderVerticalClip({
        ...effectiveOpts,
        autoReframe: false,
        reframeMode: 'off',
        framingMode: 'fit',
      });
      return;
    }

    if (canUseCaptions && subtitlesUnavailable && effectiveOpts.srtPath) {
      // Fallback for ffmpeg builds without libass/subtitles filter: hard-burn with drawtext.
      const drawtextFilters = await buildDrawtextFiltersFromSrt(effectiveOpts.srtPath);
      const baseFilter = buildBaseVideoFilters(effectiveOpts, outputWidth, outputHeight, escapedMotionTransformPath, smartCropExpr);
      if (effectiveOpts.hookTextEnabled !== false && effectiveOpts.hookText?.trim()) {
        baseFilter.push(buildHookDrawtextFilter(effectiveOpts.hookText.trim(), effectiveOpts.hookTextFilePath, effectiveOpts.hookPlacement));
      }
      const vf = [...baseFilter, ...drawtextFilters].join(',');

      try {
        await runFfmpeg([
          '-y',
          '-ss',
          String(effectiveOpts.startSec),
          '-to',
          String(effectiveOpts.endSec),
          '-i',
          effectiveOpts.inputPath,
          '-vf',
          vf,
          '-c:v',
          'libx264',
          '-preset',
          configuredPreset,
          '-crf',
          configuredCrf,
          '-maxrate',
          configuredX264Maxrate,
          '-bufsize',
          configuredX264Bufsize,
          '-profile:v',
          'high',
          '-level',
          '5.1',
          '-threads',
          '0',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          effectiveOpts.outputPath,
        ], { clipId: debugClipId, outputPath: effectiveOpts.outputPath });
        return;
      } catch (fallbackError) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        const drawtextUnavailable = /No such filter: 'drawtext'|Filter not found/i.test(fallbackMsg);

        if (drawtextUnavailable) {
          // Last-resort fallback: render without captions so export still succeeds on minimal ffmpeg builds.
          await runFfmpeg(buildArgs(false, 'libx264'), { clipId: debugClipId, outputPath: effectiveOpts.outputPath });
          return;
        }

        throw fallbackError;
      }
    }

    throw error;
  }
}
