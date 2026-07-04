import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

function run(command: string, args: string[]) {
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

export async function downloadYouTubeAudio(url: string, projectId: string) {
  const dir = path.join(process.cwd(), 'tmp', 'ingest', projectId);
  await mkdir(dir, { recursive: true });
  const outTemplate = path.join(dir, 'source.%(ext)s');

  await run('yt-dlp', ['-x', '--audio-format', 'mp3', '-o', outTemplate, url]);

  const files = await readdir(dir);
  const file = files.find((f) => f.startsWith('source.'));
  if (!file) throw new Error('Failed to download YouTube audio');
  return path.join(dir, file);
}

export async function downloadYouTubeVideo(url: string, projectId: string) {
  const dir = path.join(process.cwd(), 'tmp', 'ingest', projectId);
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, 'source.mp4');

  await run('yt-dlp', ['-f', 'mp4/bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '-o', outPath, url]);

  return outPath;
}
