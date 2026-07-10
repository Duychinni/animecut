import { spawn } from 'node:child_process';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type CaptionTemplate = 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut';
type CaptionFont = 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';

type ReframeMode = 'off' | 'basic' | 'smart';
type LayoutMode = 'single' | 'split_stack';

const VERTICAL_EXPORT_WIDTH = 1080;
const VERTICAL_EXPORT_HEIGHT = 1920;

type RenderOpts = {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  srtPath?: string;
  captionsEnabled?: boolean;
  captionTemplate?: CaptionTemplate;
  captionFont?: CaptionFont;
  hookTextEnabled?: boolean;
  hookText?: string | null;
  hookRenderMode?: 'ass' | 'drawtext';
  hookTextFilePath?: string;
  hookAssPath?: string;
  motionTracking?: boolean;
  autoReframe?: boolean;
  reframeMode?: ReframeMode;
  reframePreset?: 'auto' | 'tight' | 'left' | 'center' | 'right';
  debugReframeOverlay?: boolean;
  debugClipId?: string;
  debugCandidateId?: string;
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
  const result = await runJsonCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate',
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

function shellQuote(arg: string) {
  return /[^A-Za-z0-9_./:=,+-]/.test(arg) ? `'${arg.replace(/'/g, `'"'"'`)}'` : arg;
}

function formatCommand(cmd: string, args: string[]) {
  return [cmd, ...args].map(shellQuote).join(' ');
}

async function writeDebugCommandFile(clipId: string, commandText: string, outputPath: string) {
  const debugDir = path.join(process.cwd(), 'tmp', 'reframe-debug');
  await mkdir(debugDir, { recursive: true });
  const bundle = {
    clipId,
    outputPath,
    ffmpegCommand: commandText,
  };
  await writeFile(path.join(debugDir, `${clipId}.ffmpeg-command.txt`), `${commandText}\n`, 'utf8');
  await writeFile(path.join(debugDir, `${clipId}.bundle.json`), JSON.stringify(bundle, null, 2), 'utf8');
}

async function runFfmpeg(args: string[], debug?: { clipId?: string | null; outputPath?: string | null }) {
  const commandText = formatCommand('ffmpeg', args);
  console.log('[ffmpeg] command', { clipId: debug?.clipId ?? null, outputPath: debug?.outputPath ?? null, command: commandText });
  if (debug?.clipId && debug?.outputPath) {
    await writeDebugCommandFile(debug.clipId, commandText, debug.outputPath);
  }
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', args);
    let stderr = '';

    p.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    p.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-12).join('\n');
      reject(new Error(`ffmpeg failed: ${code}${tail ? `\n${tail}` : ''}`));
    });
    p.on('error', reject);
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

type ReframePoint = { t: number; nx: number; ny: number; w?: number; h?: number; framing?: string; mode?: string };
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
  return process.env.SMART_REFRAME_PYTHON || 'python3';
}

function resolveSmartReframeScript() {
  return process.env.SMART_REFRAME_SCRIPT || `${process.cwd()}/scripts/reframe_per_clip.py`;
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

function averageSubjectBoxes(items: SubjectBox[]): SubjectBox | undefined {
  if (!items.length) return undefined;
  const total = items.reduce(
    (acc, item) => ({
      x: acc.x + item.x,
      y: acc.y + item.y,
      w: acc.w + item.w,
      h: acc.h + item.h,
      cx: (acc.cx ?? 0) + (item.cx ?? (item.x + item.w / 2)),
      cy: (acc.cy ?? 0) + (item.cy ?? (item.y + item.h / 2)),
    }),
    { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 },
  );
  const count = items.length;
  return { x: total.x / count, y: total.y / count, w: total.w / count, h: total.h / count, cx: (total.cx ?? 0) / count, cy: (total.cy ?? 0) / count };
}

function maybeBuildSplitStackLayout(raw: {
  mode?: string;
  source_w?: number;
  source_h?: number;
  detected_faces?: Array<{ faces?: Array<{ x?: number; y?: number; w?: number; h?: number; cx?: number; cy?: number }> }>;
}): SplitStackLayout | undefined {
  if (raw.mode !== 'split_stack') return undefined;
  const sourceW = Number(raw.source_w ?? 0);
  const sourceH = Number(raw.source_h ?? 0);
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW < 100 || sourceH < 100) return undefined;

  const leftFaces: SubjectBox[] = [];
  const rightFaces: SubjectBox[] = [];
  for (const frame of raw.detected_faces ?? []) {
    const faces = (frame.faces ?? []).map((face) => normalizeBox(face)).filter(Boolean) as SubjectBox[];
    if (faces.length < 2) continue;
    faces.sort((a, b) => (a.cx ?? (a.x + a.w / 2)) - (b.cx ?? (b.x + b.w / 2)));
    leftFaces.push(faces[0]);
    rightFaces.push(faces[1]);
  }

  const topBox = averageSubjectBoxes(leftFaces);
  const bottomBox = averageSubjectBoxes(rightFaces);
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

async function maybeBuildSmartCropExpression(opts: RenderOpts): Promise<{ cropExpr?: string; layout?: SplitStackLayout }> {
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
    const script = resolveSmartReframeScript();
    const probe = await runJsonCommand(resolveSmartReframePython(), [
      script,
      opts.inputPath,
      String(opts.startSec),
      String(opts.endSec),
      '2.0',
    ]);
    const raw = probe.json as {
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
      points?: Array<{ t?: number; nx?: number; ny?: number; w?: number; h?: number; framing?: string; mode?: string }>;
      meta?: {
        points?: number;
        frames_with_detection_pct?: number;
        average_face_center?: { x?: number; y?: number };
        fallback_used?: boolean;
      };
      error?: string;
    };

    if (probe.code !== 0 || !raw?.ok) {
      console.log('[smart-reframe-fallback]', {
        clipId: opts.debugClipId ?? null,
        candidateId: opts.debugCandidateId ?? null,
        reason: probe.code !== 0 ? 'python_probe_nonzero_exit' : 'raw_not_ok',
        probeCode: probe.code,
        raw,
      });
      return {};
    }

    const clipId = (opts.debugClipId ?? opts.outputPath.split('/').pop()?.replace(/\.mp4$/, '')) || 'unknown';
    const candidateId = opts.debugCandidateId ?? null;
    const backendScript = script;
    let jsonSaved = false;

    if (process.env.DEBUG_REFRAME_SAVE_JSON === 'true') {
      const debugDir = `${process.cwd()}/tmp/reframe-debug`;
      await mkdir(debugDir, { recursive: true });
      await writeFile(`${debugDir}/${clipId}.json`, JSON.stringify(raw, null, 2), 'utf8');
      jsonSaved = true;
    }

    const splitStackLayout = maybeBuildSplitStackLayout(raw);
    if (splitStackLayout) {
      console.log('[smart-reframe-layout]', {
        clipId,
        candidateId,
        mode: splitStackLayout.mode,
        topBox: splitStackLayout.topBox,
        bottomBox: splitStackLayout.bottomBox,
      });
      return { layout: splitStackLayout };
    }

    if (raw.mode === 'per_clip' && typeof raw.crop_w === 'number' && typeof raw.crop_h === 'number' && typeof raw.crop_x === 'number') {
      const outputHeight = resolveOutputHeight();
      const outputWidth = resolveOutputWidth(outputHeight);
      const sourceW = Number(raw.source_w ?? 0);
      const sourceH = Number(raw.source_h ?? 0);
      const scale = sourceW > 0 && sourceH > 0
        ? Math.max(outputWidth / sourceW, outputHeight / sourceH)
        : 1;
      const scaledW = sourceW * scale;
      const scaledH = sourceH * scale;
      const scaledCropX = clamp(raw.crop_x * scale, 0, Math.max(0, scaledW - outputWidth));
      const rawCropY = Number((raw as { crop_y?: number }).crop_y ?? 0);
      const scaledCropY = clamp(rawCropY * scale, 0, Math.max(0, scaledH - outputHeight));
      const cropExpr = `crop=${outputWidth}:${outputHeight}:${Math.round(scaledCropX)}:${Math.round(scaledCropY)}`;
      console.log('[smart-reframe]', {
        clipId,
        candidateId,
        backendScript,
        mode: raw.mode,
        source_w: raw.source_w ?? null,
        source_h: raw.source_h ?? null,
        crop_x: raw.crop_x,
        crop_y: 0,
        crop_w: raw.crop_w,
        crop_h: raw.crop_h,
        scaled_crop_x: Math.round(scaledCropX),
        scaled_crop_y: Math.round(scaledCropY),
        scaled_crop_expr: cropExpr,
        detected_center_x: raw.detected_center_x ?? null,
        fallbackUsed: raw.fallback_used ?? null,
        ffmpeg_crop: raw.ffmpeg_crop ?? null,
        jsonSaved,
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

    const stabilized = downsamplePoints(smoothPoints(points, 0.62), 20);

    const preset = opts.reframePreset ?? 'auto';
    const cropWidth = VERTICAL_EXPORT_WIDTH;
    const cropHeight = VERTICAL_EXPORT_HEIGHT;

    const xExprRaw = buildTimelineExpr(
      stabilized,
      (p) => {
        const faceWidthNorm = p.w && Number.isFinite(p.w) ? p.w / 1920 : 0;
        const baseBias = p.framing === 'wide_pair' ? 0.5 : clamp01(p.nx);
        const presetBias = preset === 'left' ? 0.38 : preset === 'right' ? 0.62 : preset === 'center' ? 0.5 : baseBias;
        const pairBias = preset === 'center' ? 0.5 : presetBias;
        const stableBias = preset === 'tight' ? 0.32 : p.framing === 'single_stable' ? 0.3 : 0.22;
        const edgeGuard = preset === 'tight' ? 0.02 : faceWidthNorm > 0.22 ? 0.05 : faceWidthNorm > 0.18 ? 0.03 : 0.005;
        const centeredBias = preset === 'tight' || preset === 'center'
          ? 0.5 + (pairBias - 0.5) * 1.5
          : 0.5 + (pairBias - 0.5) * 1.32;
        const target = clamp01(edgeGuard + centeredBias * (1 - edgeGuard * 2) + (centeredBias - 0.5) * stableBias);
        return `min(max((iw-${cropWidth})*${target.toFixed(4)},0),iw-${cropWidth})`;
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

    return { cropExpr: `crop=${VERTICAL_EXPORT_WIDTH}:${VERTICAL_EXPORT_HEIGHT}:${xExpr}:${yExpr}` };
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

function buildSplitStackFilter(
  opts: RenderOpts,
  layout: SplitStackLayout,
  includeCaptions: boolean,
  escapedPath?: string,
  captionPath?: string,
) {
  const cropWidth = Math.min(layout.cropWidth, layout.sourceW);
  const paneHeight = 850;
  const seamHeight = layout.outputHeight - paneHeight * 2;
  const topCenterX = layout.topBox.cx ?? (layout.topBox.x + layout.topBox.w / 2);
  const bottomCenterX = layout.bottomBox.cx ?? (layout.bottomBox.x + layout.bottomBox.w / 2);
  const topCropX = clamp(topCenterX - cropWidth / 2, 0, layout.sourceW - cropWidth);
  const bottomCropX = clamp(bottomCenterX - cropWidth / 2, 0, layout.sourceW - cropWidth);

  const topCropY = clamp((layout.topBox.y + layout.topBox.h * 0.18) - paneHeight * 0.42, 0, layout.sourceH - paneHeight);
  const bottomCropY = clamp((layout.bottomBox.y + layout.bottomBox.h * 0.18) - paneHeight * 0.42, 0, layout.sourceH - paneHeight);

  const filterParts = [
    `[0:v]split=2[topsrc][bottomsrc]`,
    `[topsrc]crop=${Math.round(cropWidth)}:${paneHeight}:${Math.round(topCropX)}:${Math.round(topCropY)},scale=${layout.outputWidth}:${paneHeight}:flags=lanczos[topv]`,
    `[bottomsrc]crop=${Math.round(cropWidth)}:${paneHeight}:${Math.round(bottomCropX)}:${Math.round(bottomCropY)},scale=${layout.outputWidth}:${paneHeight}:flags=lanczos[bottomv]`,
    `color=c=black:s=${layout.outputWidth}x${layout.outputHeight}:d=1[base]`,
    `[base][topv]overlay=0:0[tmp1]`,
    `[tmp1][bottomv]overlay=0:${paneHeight + seamHeight}[tmp2]`,
    `[tmp2]drawbox=x=0:y=${paneHeight}:w=${layout.outputWidth}:h=${seamHeight}:color=black@0.88:t=fill[tmp3]`,
  ];

  let videoLabel = 'tmp3';

  if (opts.hookTextEnabled !== false && opts.hookText && opts.hookText.trim()) {
    filterParts.push(`[${videoLabel}]${buildHookFilter(opts)}[tmpHook]`);
    videoLabel = 'tmpHook';
  }

  if (includeCaptions && escapedPath) {
    const isAssInput = (captionPath ?? '').toLowerCase().endsWith('.ass');
    if (isAssInput) {
      filterParts.push(`[${videoLabel}]subtitles=filename='${escapedPath}'[outv]`);
    } else {
      const style = escapeForceStyleForFilter([
        'FontName=Arial Black',
        'FontSize=118',
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
      filterParts.push(`[${videoLabel}]subtitles=filename='${escapedPath}':force_style='${style}'[outv]`);
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
  const cropWidth = VERTICAL_EXPORT_WIDTH;
  const cropHeight = VERTICAL_EXPORT_HEIGHT;

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
    const shouldWrap = current.length > 0 && (next.length > 21 || current.length >= 4);

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

function buildHookAss(hookText: string) {
  const lines = hookText.split('\n').filter(Boolean);
  const twoLine = lines.length > 1;
  const cardWidth = 770;
  const cardHeight = twoLine ? 188 : 130;
  const cardX = Math.round((VERTICAL_EXPORT_WIDTH - cardWidth) / 2);
  const cardY = twoLine ? 66 : 82;
  const textY = cardY + Math.round(cardHeight / 2) + (twoLine ? 2 : 0);
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
Style: HookText,Arial Black,${hookFontSize},&H00000000,&H00000000,&H00111111,&H55000000,-1,0,0,0,100,106,0,0,1,1,1,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:04.50,HookCard,,0,0,0,,{\\an7\\pos(0,0)\\p1\\c&HFFFFFF&}${cardShape}
Dialogue: 1,0:00:00.00,0:00:04.50,HookText,,0,0,0,,{\\an5\\pos(540,${textY})}${text}
`;
}

function buildHookDrawtextFilter(hookText: string, hookTextFilePath?: string) {
  const wrapped = wrapHookTextForDrawtext(hookText);
  const source = hookTextFilePath
    ? `textfile='${escapeDrawtextPathForFilter(hookTextFilePath)}':reload=0`
    : `text='${escapeDrawtextText(wrapped)}'`;
  return [
    `drawtext=${source}`,
    "font='Arial Black'",
    'fontcolor=black',
    'fontsize=74',
    'box=1',
    'boxcolor=white@0.98',
    'boxborderw=30',
    'borderw=1',
    'bordercolor=black@0.72',
    'shadowx=1',
    'shadowy=2',
    'shadowcolor=black@0.28',
    'line_spacing=9',
    'fix_bounds=1',
    'x=(w-text_w)/2',
    'y=86',
    drawtextBetween(0, 4.5),
  ].join(':');
}

function buildHookFilter(opts: RenderOpts) {
  if (opts.hookRenderMode !== 'drawtext' && opts.hookAssPath) {
    return `subtitles=filename='${escapeSubtitlesPathForFilter(opts.hookAssPath)}'`;
  }
  return buildHookDrawtextFilter(opts.hookText?.trim() ?? '', opts.hookTextFilePath);
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
  const filterParts = [`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase:flags=lanczos`];

  if (escapedMotionTransformPath) {
    filterParts.push(
      `vidstabtransform=input='${escapedMotionTransformPath}':smoothing=28:optzoom=0:interpol=bicubic`,
    );
  }

  filterParts.push(buildCropFilter(opts, smartCropExpr));
  filterParts.push(`scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1`);

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
        'FontSize=10',
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
        'FontSize=11',
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
        'FontSize=12',
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
        'FontSize=13',
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
        'FontSize=9',
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
        'FontSize=14',
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
        'FontSize=8',
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
        'FontSize=118',
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
      filterParts.push(`subtitles=filename='${escapedPath}'`);
    } else {
      const style = escapeForceStyleForFilter(styleMap[template].join(','));
      filterParts.push(`subtitles=filename='${escapedPath}':force_style='${style}'`);
    }
  }

  return filterParts.join(',');
}

export async function renderVerticalClip(opts: RenderOpts) {
  const outputHeight = resolveOutputHeight();
  const outputWidth = resolveOutputWidth(outputHeight);
  const envMode = ((process.env.AUTO_REFRAME_MODE || 'basic').trim().toLowerCase() as ReframeMode);
  const effectiveMode: ReframeMode = opts.reframeMode ?? (envMode === 'off' || envMode === 'smart' ? envMode : 'basic');
  console.log('[render] reframe-mode', {
    clipId: opts.debugClipId ?? null,
    requestedMode: opts.reframeMode ?? null,
    envMode,
    effectiveMode,
    autoReframeRequested: opts.autoReframe ?? null,
    autoReframeEnabled: opts.autoReframe ?? process.env.AUTO_REFRAME_ENABLED !== 'false',
    smartScript: resolveSmartReframeScript(),
    smartPython: resolveSmartReframePython(),
  });
  const effectiveOpts: RenderOpts = {
    ...opts,
    autoReframe: opts.autoReframe ?? process.env.AUTO_REFRAME_ENABLED !== 'false',
    reframeMode: effectiveMode,
    debugReframeOverlay: opts.debugReframeOverlay ?? process.env.DEBUG_REFRAME_OVERLAY === 'true',
  };

  let escapedPath: string | undefined;
  let canUseCaptions = false;
  let escapedMotionTransformPath: string | undefined;
  const smartReframe = await maybeBuildSmartCropExpression(effectiveOpts);
  const smartCropExpr = smartReframe.cropExpr;
  const splitStackLayout = smartReframe.layout;

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
        `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase:flags=lanczos,vidstabdetect=shakiness=7:accuracy=15:result='${escapedMotionTransformPath}'`,
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

  const configuredEncoder = (process.env.FFMPEG_VIDEO_ENCODER || 'libx264').trim();
  const configuredPreset = (process.env.FFMPEG_X264_PRESET || 'medium').trim();
  const configuredCrf = (process.env.FFMPEG_X264_CRF || '18').trim();

  const debugClipId = (effectiveOpts.debugClipId ?? effectiveOpts.outputPath.split('/').pop()?.replace(/\.mp4$/, '')) || 'unknown';
  if (effectiveOpts.hookTextEnabled !== false && effectiveOpts.hookText?.trim()) {
    const wrappedHookText = wrapHookTextForDrawtext(effectiveOpts.hookText);
    const hookFilePath = `${effectiveOpts.outputPath}.hook.txt`;
    await writeFile(hookFilePath, wrappedHookText, 'utf8');
    effectiveOpts.hookTextFilePath = hookFilePath;
    if ((effectiveOpts.hookRenderMode ?? 'ass') === 'ass') {
      const hookAssPath = `${effectiveOpts.outputPath}.hook.ass`;
      await writeFile(hookAssPath, buildHookAss(wrappedHookText), 'utf8');
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

    if (splitStackLayout) {
      common.push(
        '-filter_complex',
        buildSplitStackFilter(effectiveOpts, splitStackLayout, includeCaptions, escapedPath, effectiveOpts.srtPath),
        '-map',
        '[outv]',
      );
    } else {
      common.push(
        '-vf',
        buildFilter(effectiveOpts, includeCaptions, escapedPath, escapedMotionTransformPath, effectiveOpts.srtPath, smartCropExpr),
      );
    }

    common.push(
      '-r',
      '30',
      '-c:v',
      encoder,
    );

    if (encoder === 'libx264') {
      common.push('-preset', configuredPreset, '-crf', configuredCrf, '-threads', '0');
    } else {
      // Hardware encoders (nvenc/qsv/videotoolbox) usually ignore CRF/preset semantics.
      common.push('-b:v', process.env.FFMPEG_HW_VIDEO_BITRATE || '12M', '-maxrate', process.env.FFMPEG_HW_MAXRATE || '16M');
    }

    common.push(
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      effectiveOpts.outputPath,
    );

    return common;
  };

  try {
    console.log('[render] output-path', { clipId: debugClipId, localMp4Path: effectiveOpts.outputPath, inputPath: effectiveOpts.inputPath, startSec: effectiveOpts.startSec, endSec: effectiveOpts.endSec, smartCropExpr: smartCropExpr ?? null, splitStack: Boolean(splitStackLayout) });
    await runFfmpeg(buildArgs(canUseCaptions), { clipId: debugClipId, outputPath: effectiveOpts.outputPath });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const subtitlesUnavailable = /No such filter: 'subtitles'/i.test(msg);
    const textOverlayFailed = /drawtext|Cannot find a valid font|Error initializing filter|No such filter: '[0-9.]+|No such filter: 'between|Filter not found/i.test(msg);
    const encoderUnavailable = /Unknown encoder|Error while opening encoder|Encoder .* not found|Invalid argument/i.test(msg);

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

    if (canUseCaptions && subtitlesUnavailable && effectiveOpts.srtPath) {
      // Fallback for ffmpeg builds without libass/subtitles filter: hard-burn with drawtext.
      const drawtextFilters = await buildDrawtextFiltersFromSrt(effectiveOpts.srtPath);
      const baseFilter = [`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase:flags=lanczos`];
      if (escapedMotionTransformPath) {
        baseFilter.push(
          `vidstabtransform=input='${escapedMotionTransformPath}':smoothing=28:optzoom=0:interpol=bicubic`,
        );
      }
      baseFilter.push(buildCropFilter(effectiveOpts, smartCropExpr));
      baseFilter.push(`scale=${outputWidth}:${outputHeight}:flags=lanczos,setsar=1`);
      if (effectiveOpts.hookTextEnabled !== false && effectiveOpts.hookText?.trim()) {
        baseFilter.push(buildHookDrawtextFilter(effectiveOpts.hookText.trim(), effectiveOpts.hookTextFilePath));
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
          '-r',
          '30',
          '-c:v',
          'libx264',
          '-preset',
          configuredPreset,
          '-crf',
          configuredCrf,
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
