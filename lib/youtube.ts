import { spawn } from 'node:child_process';
import { access, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getPublicPipelineError, isYouTubeSourceBlocked } from '@/lib/pipeline-errors';

async function resolveYtDlpBinary() {
  const candidates = [
    process.env.YT_DLP_PATH,
    path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'),
    '/opt/homebrew/bin/yt-dlp',
    'yt-dlp',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (candidate === 'yt-dlp') return candidate;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep checking
    }
  }

  return 'yt-dlp';
}

async function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(command, args);
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
    p.on('error', reject);
  });
}

async function runJson(command: string, args: string[]) {
  return new Promise<unknown>((resolve, reject) => {
    const p = spawn(command, args);
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    p.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${command} exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch {
        reject(new Error(`${command} returned non-JSON output`));
      }
    });
    p.on('error', reject);
  });
}

const COMMON_YT_DLP_ARGS = [
  '--no-playlist',
  '--force-ipv4',
  '--socket-timeout', '30',
  '--retries', '5',
  '--fragment-retries', '5',
  '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  '--add-header', 'Accept-Language: en-US,en;q=0.9',
];

const YOUTUBE_CLIENT_ATTEMPTS = [
  ['--extractor-args', 'youtube:player_client=android,web'],
  ['--extractor-args', 'youtube:player_client=ios,android,web'],
  ['--extractor-args', 'youtube:player_client=web'],
];

const SOURCE_QUALITY_CACHE_VERSION = 'yt-hd-source-v3-2160p';

function getYouTubeMaxSourceHeight() {
  const raw = Number(process.env.YOUTUBE_MAX_SOURCE_HEIGHT ?? 2160);
  if (!Number.isFinite(raw) || raw < 720) return 2160;
  return Math.min(2160, Math.round(raw));
}

function getYouTubeMinCacheHeight() {
  const raw = Number(process.env.YOUTUBE_MIN_CACHE_HEIGHT ?? 1440);
  if (!Number.isFinite(raw) || raw < 480) return 1440;
  return Math.min(getYouTubeMaxSourceHeight(), Math.round(raw));
}

function getYouTubeVideoFormat() {
  const override = process.env.YOUTUBE_VIDEO_FORMAT?.trim();
  if (override) return override;

  const maxHeight = getYouTubeMaxSourceHeight();
  return [
    `bv*[height<=${maxHeight}]+ba`,
    `b[height<=${maxHeight}]`,
    'bv*+ba',
    'best',
  ].join('/');
}

type DownloadedVideoInfo = {
  width: number | null;
  height: number | null;
  codec: string | null;
  fps: string | null;
  videoBitrate: string | null;
  containerBitrate: string | null;
  duration: string | null;
  size: string | null;
};

async function probeDownloadedVideoInfo(filePath: string): Promise<DownloadedVideoInfo> {
  const info = await runJson('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,bit_rate',
    '-of', 'json',
    filePath,
  ]) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      bit_rate?: string;
    }>;
    format?: { duration?: string; size?: string; bit_rate?: string };
  };
  const video = (info.streams ?? []).find((stream) => stream.codec_type === 'video');
  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    codec: video?.codec_name ?? null,
    fps: video?.avg_frame_rate ?? null,
    videoBitrate: video?.bit_rate ?? null,
    containerBitrate: info.format?.bit_rate ?? null,
    duration: info.format?.duration ?? null,
    size: info.format?.size ?? null,
  };
}

async function logDownloadedVideoInfo(filePath: string, projectId: string, formatSelector: string) {
  try {
    const info = await probeDownloadedVideoInfo(filePath);
    console.log('[youtube] downloaded-source', { projectId, formatSelector, ...info });
    return info;
  } catch (error) {
    console.warn('[youtube] downloaded-source-probe-failed', {
      projectId,
      error: error instanceof Error ? error.message : 'Unknown probe error',
    });
    return null;
  }
}

async function getCachedQualityMarker(markerPath: string) {
  try {
    return JSON.parse(await readFile(markerPath, 'utf8')) as {
      checkedHeight?: number | null;
      refreshedLowQuality?: boolean;
      qualityVersion?: string;
    };
  } catch {
    return null;
  }
}

async function writeCachedQualityMarker(markerPath: string, info: DownloadedVideoInfo | null, refreshedLowQuality = false) {
  await writeFile(markerPath, JSON.stringify({
    checkedAt: new Date().toISOString(),
    checkedHeight: info?.height ?? null,
    checkedWidth: info?.width ?? null,
    refreshedLowQuality,
    qualityVersion: SOURCE_QUALITY_CACHE_VERSION,
  }), 'utf8').catch(() => undefined);
}

async function runYtDlpWithFallbacks(command: string, args: string[]) {
  let lastError: unknown = null;

  for (const clientArgs of YOUTUBE_CLIENT_ATTEMPTS) {
    try {
      await run(command, [...COMMON_YT_DLP_ARGS, ...clientArgs, ...args]);
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }

  if (isYouTubeSourceBlocked(lastError)) {
    throw new Error(getPublicPipelineError(lastError));
  }

  throw lastError instanceof Error ? lastError : new Error('YouTube download failed');
}

export async function downloadYouTubeAudio(url: string, projectId: string) {
  const dir = path.join(process.cwd(), 'tmp', 'ingest', projectId);
  await mkdir(dir, { recursive: true });
  const outTemplate = path.join(dir, 'source.%(ext)s');
  const ytDlp = await resolveYtDlpBinary();

  await runYtDlpWithFallbacks(ytDlp, ['-x', '--audio-format', 'mp3', '-o', outTemplate, url]);

  const files = await readdir(dir);
  const file = files.find((f) => f.startsWith('source.'));
  if (!file) throw new Error('Failed to download YouTube audio');
  return path.join(dir, file);
}

export async function downloadYouTubeVideo(url: string, projectId: string) {
  const dir = path.join(process.cwd(), 'tmp', 'ingest', projectId);
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, 'source.mp4');
  const qualityMarkerPath = `${outPath}.quality.json`;
  const ytDlp = await resolveYtDlpBinary();
  let refreshedLowQualityCache = false;

  try {
    const cached = await stat(outPath);
    if (cached.size > 0) {
      const cachedInfo = await logDownloadedVideoInfo(outPath, projectId, 'cached');
      const qualityMarker = await getCachedQualityMarker(qualityMarkerPath);
      const minHeight = getYouTubeMinCacheHeight();
      const cachedHeight = cachedInfo?.height ?? qualityMarker?.checkedHeight ?? null;
      const alreadyRefreshedLowQuality = qualityMarker?.refreshedLowQuality === true
        && qualityMarker?.qualityVersion === SOURCE_QUALITY_CACHE_VERSION;

      if (cachedHeight && cachedHeight >= minHeight) {
        await writeCachedQualityMarker(qualityMarkerPath, cachedInfo, false);
        return outPath;
      }

      if (cachedHeight && cachedHeight < minHeight && alreadyRefreshedLowQuality) {
        await writeCachedQualityMarker(qualityMarkerPath, cachedInfo, true);
        return outPath;
      }

      if (!cachedHeight && qualityMarker?.qualityVersion === SOURCE_QUALITY_CACHE_VERSION) {
        await writeCachedQualityMarker(qualityMarkerPath, cachedInfo, alreadyRefreshedLowQuality);
        return outPath;
      }

      console.warn('[youtube] cached-source-below-hd-refreshing', {
        projectId,
        cachedHeight,
        minHeight,
        qualityVersion: qualityMarker?.qualityVersion ?? null,
        currentQualityVersion: SOURCE_QUALITY_CACHE_VERSION,
      });
      await unlink(outPath).catch(() => undefined);
      refreshedLowQualityCache = true;
    }
  } catch {
    // no cached video in this worker
  }

  const formatSelector = getYouTubeVideoFormat();
  await runYtDlpWithFallbacks(ytDlp, [
    '--concurrent-fragments', '8',
    '--format-sort', 'res,fps,hdr:12,vcodec,acodec',
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '-o', outPath,
    url,
  ]);

  const downloadedInfo = await logDownloadedVideoInfo(outPath, projectId, formatSelector);
  const stillBelowMin = Boolean(downloadedInfo?.height && downloadedInfo.height < getYouTubeMinCacheHeight());
  await writeCachedQualityMarker(qualityMarkerPath, downloadedInfo, refreshedLowQualityCache || stillBelowMin);

  return outPath;
}
