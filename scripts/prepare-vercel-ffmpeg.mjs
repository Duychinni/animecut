import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

if (!ffmpegPath) {
  throw new Error('ffmpeg-static did not provide an executable for this platform.');
}

const destination = path.join(process.cwd(), 'public', 'bin', 'ffmpeg');
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(ffmpegPath, destination);
await chmod(destination, 0o755);
console.log(`Prepared FFmpeg for the serverless render route: ${destination}`);
