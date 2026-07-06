import { spawn } from 'node:child_process';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';

type CaptionTemplate = 'clean' | 'bold' | 'viral' | 'karaoke' | 'cinematic' | 'rage' | 'minimal' | 'capcut';
type CaptionFont = 'arial' | 'montserrat' | 'impact' | 'bangers' | 'anton' | 'bebas' | 'poppins';

type ReframeMode = 'off' | 'basic' | 'smart';

type RenderOpts = {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  srtPath?: string;
  captionsEnabled?: boolean;
  captionTemplate?: CaptionTemplate;
  captionFont?: CaptionFont;
  motionTracking?: boolean;
  autoReframe?: boolean;
  reframeMode?: ReframeMode;
  debugReframeOverlay?: boolean;
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

async function runFfmpeg(args: string[]) {
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
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
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
        `drawtext=text='${text}':fontcolor=white:fontsize=108:borderw=8:bordercolor=black:x=(w-text_w)/2:y=h-620:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`,
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
      `drawtext=text='${text}':fontcolor=white:fontsize=108:borderw=8:bordercolor=black:x=(w-text_w)/2:y=h-620:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`,
    );
  }

  return filters;
}

type ReframePoint = { t: number; nx: number; ny: number; w?: number; h?: number; framing?: string; mode?: string };

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

async function maybeBuildSmartCropExpression(opts: RenderOpts): Promise<string | undefined> {
  if (opts.reframeMode !== 'smart' || opts.autoReframe === false) return undefined;

  try {
    const script = `${process.cwd()}/scripts/reframe_cv.py`;
    const probe = await runJsonCommand(resolveSmartReframePython(), [
      script,
      opts.inputPath,
      String(opts.startSec),
      String(opts.endSec),
      '2.0',
    ]);
    const raw = probe.json as {
      ok?: boolean;
      points?: Array<{ t?: number; nx?: number; ny?: number; w?: number; h?: number; framing?: string; mode?: string }>;
      meta?: {
        points?: number;
        frames_with_detection_pct?: number;
        average_face_center?: { x?: number; y?: number };
        fallback_used?: boolean;
      };
      error?: string;
    };

    if (probe.code !== 0 || !raw?.ok || !raw?.points?.length) return undefined;

    const clipId = opts.outputPath.split('/').pop()?.replace(/\.mp4$/, '') || 'unknown';

    console.log('[smart-reframe]', {
      clipId,
      detectionsFound: raw?.meta?.points ?? raw.points.length,
      averageFaceCenterX: raw?.meta?.average_face_center?.x ?? null,
      averageFaceCenterY: raw?.meta?.average_face_center?.y ?? null,
      framesWithDetectionPct: raw?.meta?.frames_with_detection_pct ?? null,
      fallbackUsed: raw?.meta?.fallback_used ?? null,
    });

    if (process.env.DEBUG_REFRAME_SAVE_JSON === 'true') {
      const debugDir = `${process.cwd()}/tmp/reframe-debug`;
      await mkdir(debugDir, { recursive: true });
      await writeFile(`${debugDir}/${clipId}.json`, JSON.stringify(raw, null, 2), 'utf8');
    }

    const points = raw.points
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

    if (points.length < 2) return undefined;

    const stabilized = downsamplePoints(smoothPoints(points, 0.62), 20);

    const xExprRaw = buildTimelineExpr(
      stabilized,
      (p) => {
        const faceWidthNorm = p.w && Number.isFinite(p.w) ? p.w / 1920 : 0;
        const pairBias = p.framing === 'wide_pair' ? 0.5 : clamp01(p.nx);
        const stableBias = p.framing === 'single_stable' ? 0.18 : 0.1;
        const edgeGuard = faceWidthNorm > 0.22 ? 0.09 : faceWidthNorm > 0.18 ? 0.06 : 0.02;
        const centeredBias = 0.5 + (pairBias - 0.5) * 1.12;
        const target = clamp01(edgeGuard + centeredBias * (1 - edgeGuard * 2) + (centeredBias - 0.5) * stableBias);
        return `min(max((iw-1080)*${target.toFixed(4)},0),iw-1080)`;
      },
      '(iw-1080)/2',
    );

    // Better podcast/interview framing: keep eyes in the upper-middle instead of centering the whole body.
    const yExprRaw = buildTimelineExpr(
      stabilized,
      (p) => {
        const isPair = p.framing === 'wide_pair';
        const isStableSingle = p.framing === 'single_stable';
        const headroomBias = isPair ? 0.07 : isStableSingle ? 0.26 : 0.23;
        const target = clamp01((p.ny ?? 0.42) - headroomBias);
        return `min(max((ih-1920)*${target.toFixed(4)},0),ih-1920)`;
      },
      'min(max((ih-1920)*0.30,0),ih-1920)',
    );

    const xExpr = escapeFfmpegExpr(xExprRaw);
    const yExpr = escapeFfmpegExpr(yExprRaw);

    return `crop=1080:1920:${xExpr}:${yExpr}`;
  } catch {
    return undefined;
  }
}

function buildCropFilter(opts: RenderOpts, smartCropExpr?: string) {
  const mode = opts.reframeMode ?? 'off';
  const enabled = opts.autoReframe !== false && mode !== 'off';

  if (!enabled) return 'crop=1080:1920';
  if (mode === 'smart' && smartCropExpr) return smartCropExpr;

  // Baseline stable framing with better portrait headroom for talking-head clips.
  const xExpr = '(iw-1080)/2';
  const yExpr = escapeFfmpegExpr('min(max((ih-1920)*0.26,0),ih-1920)');
  return `crop=1080:1920:${xExpr}:${yExpr}`;
}

function resolveOutputHeight() {
  const raw = Number(process.env.EXPORT_MAX_HEIGHT ?? 1920);
  if (!Number.isFinite(raw) || raw < 1280) return 1920;
  return Math.round(raw);
}

function resolveOutputWidth(outputHeight: number) {
  return Math.round((outputHeight * 9) / 16);
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
  const filterParts = [`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase`];

  if (escapedMotionTransformPath) {
    filterParts.push(
      `vidstabtransform=input='${escapedMotionTransformPath}':smoothing=28:optzoom=0:interpol=bicubic`,
    );
  }

  filterParts.push(buildCropFilter(opts, smartCropExpr));

  if (opts.debugReframeOverlay) {
    filterParts.push(
      "drawbox=x=w*0.5-6:y=0:w=12:h=h:color=yellow@0.65:t=fill",
      "drawbox=x=0:y=h*0.35:w=w:h=6:color=cyan@0.55:t=fill",
      "drawbox=x=0:y=h*0.45:w=w:h=6:color=cyan@0.55:t=fill"
    );
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
        `FontName=${fontMap[captionFont]}`,
        'FontSize=86',
        'PrimaryColour=&H00FFFFFF',
        'SecondaryColour=&H0000FFFF',
        'OutlineColour=&H00101010',
        'BorderStyle=1',
        'Outline=8',
        'Shadow=0',
        'Bold=1',
        'Spacing=0',
        'ScaleX=126',
        'ScaleY=108',
        'MarginV=360',
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
  const effectiveOpts: RenderOpts = {
    ...opts,
    autoReframe: opts.autoReframe ?? process.env.AUTO_REFRAME_ENABLED !== 'false',
    reframeMode: effectiveMode,
    debugReframeOverlay: opts.debugReframeOverlay ?? process.env.DEBUG_REFRAME_OVERLAY === 'true',
  };

  let escapedPath: string | undefined;
  let canUseCaptions = false;
  let escapedMotionTransformPath: string | undefined;
  const smartCropExpr = await maybeBuildSmartCropExpression(effectiveOpts);

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
        `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase,vidstabdetect=shakiness=7:accuracy=15:result='${escapedMotionTransformPath}'`,
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
  const configuredPreset = (process.env.FFMPEG_X264_PRESET || 'veryfast').trim();
  const configuredCrf = (process.env.FFMPEG_X264_CRF || '22').trim();

  const buildArgs = (includeCaptions: boolean, encoder = configuredEncoder) => {
    const common = [
      '-y',
      '-ss',
      String(effectiveOpts.startSec),
      '-to',
      String(effectiveOpts.endSec),
      '-i',
      effectiveOpts.inputPath,
      '-vf',
      buildFilter(effectiveOpts, includeCaptions, escapedPath, escapedMotionTransformPath, effectiveOpts.srtPath, smartCropExpr),
      '-r',
      '30',
      '-c:v',
      encoder,
    ];

    if (encoder === 'libx264') {
      common.push('-preset', configuredPreset, '-crf', configuredCrf, '-threads', '0');
    } else {
      // Hardware encoders (nvenc/qsv/videotoolbox) usually ignore CRF/preset semantics.
      common.push('-b:v', process.env.FFMPEG_HW_VIDEO_BITRATE || '5M', '-maxrate', process.env.FFMPEG_HW_MAXRATE || '8M');
    }

    common.push(
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      effectiveOpts.outputPath,
    );

    return common;
  };

  try {
    await runFfmpeg(buildArgs(canUseCaptions));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const subtitlesUnavailable = /No such filter: 'subtitles'|Filter not found/i.test(msg);
    const encoderUnavailable = /Unknown encoder|Error while opening encoder|Encoder .* not found|Invalid argument/i.test(msg);

    if (configuredEncoder !== 'libx264' && encoderUnavailable) {
      // Server-safe fallback: if requested hardware encoder is unavailable on this host,
      // transparently retry with libx264 so customer renders still succeed.
      await runFfmpeg(buildArgs(canUseCaptions, 'libx264'));
      return;
    }

    if (canUseCaptions && subtitlesUnavailable && effectiveOpts.srtPath) {
      // Fallback for ffmpeg builds without libass/subtitles filter: hard-burn with drawtext.
      const drawtextFilters = await buildDrawtextFiltersFromSrt(effectiveOpts.srtPath);
      const baseFilter = [`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=increase`];
      if (escapedMotionTransformPath) {
        baseFilter.push(
          `vidstabtransform=input='${escapedMotionTransformPath}':smoothing=28:optzoom=0:interpol=bicubic`,
        );
      }
      baseFilter.push(buildCropFilter(effectiveOpts, smartCropExpr));
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
          'veryfast',
          '-crf',
          '22',
          '-threads',
          '0',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          effectiveOpts.outputPath,
        ]);
        return;
      } catch (fallbackError) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        const drawtextUnavailable = /No such filter: 'drawtext'|Filter not found/i.test(fallbackMsg);

        if (drawtextUnavailable) {
          // Last-resort fallback: render without captions so export still succeeds on minimal ffmpeg builds.
          await runFfmpeg(buildArgs(false, 'libx264'));
          return;
        }

        throw fallbackError;
      }
    }

    throw error;
  }
}
