import { spawn } from 'node:child_process';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
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
  const ytDlp = await resolveYtDlpBinary();

  try {
    const cached = await stat(outPath);
    if (cached.size > 0) return outPath;
  } catch {
    // no cached video in this worker
  }

  await runYtDlpWithFallbacks(ytDlp, [
    '--concurrent-fragments', '4',
    '--format-sort', 'res,fps,hdr:12,vcodec,acodec',
    '-f', 'bestvideo*+bestaudio/best',
    '--merge-output-format', 'mp4',
    '-o', outPath,
    url,
  ]);

  return outPath;
}
