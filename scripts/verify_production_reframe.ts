import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderVerticalClip, validateRenderedVideo } from '../lib/ffmpeg';

const source = process.argv[2];
const outputDir = process.argv[3];
if (!source || !outputDir) throw new Error('usage: verify_production_reframe.ts <source> <output-dir>');

const cases = [
  { id: 'A_far_left', start: 267, end: 274 },
  { id: 'B_far_right', start: 336, end: 343 },
  { id: 'C_centered', start: 8, end: 15 },
  { id: 'D_two_visible', start: 0, end: 8 },
  { id: 'E_profile_turn', start: 72, end: 82 },
  { id: 'F_temporary_occlusion', start: 18, end: 27 },
  { id: 'G_hard_camera_cut', start: 8, end: 15 },
] as const;

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const manifest: Array<Record<string, unknown>> = [];

  for (const item of cases) {
  const outputPath = path.join(outputDir, `${item.id}.mp4`);
  const metadataPath = path.join(outputDir, `${item.id}.crop-layout.json`);
  const overlayPath = path.join(outputDir, `${item.id}.debug-overlay.mp4`);
  const overlayCommandPath = path.join(outputDir, `${item.id}.debug-overlay.ffmpeg-command.txt`);
  process.env.SMART_REFRAME_METADATA_PATH = metadataPath;
  process.env.SMART_REFRAME_DEBUG_CLIP_ID = item.id;
  await renderVerticalClip({
    inputPath: source,
    outputPath,
    startSec: item.start,
    endSec: item.end,
    captionsEnabled: false,
    hookTextEnabled: false,
    autoReframe: true,
    reframeMode: 'smart',
    framingMode: 'auto',
    motionTracking: true,
    debugClipId: item.id,
    debugCandidateId: `production-acceptance-${item.id}`,
  });
  const validation = await validateRenderedVideo(outputPath);
  const productionCommandSource = path.join(process.cwd(), 'tmp', 'reframe-debug', `${item.id}.ffmpeg-command.txt`);
  const productionCommandPath = path.join(outputDir, `${item.id}.production.ffmpeg-command.txt`);
  await copyFile(productionCommandSource, productionCommandPath);
  await run(process.env.SMART_REFRAME_PYTHON || 'python', [
    path.join(process.cwd(), 'scripts', 'reframe_debug_overlay.py'),
    source, metadataPath, String(item.start), String(item.end), overlayPath, overlayCommandPath,
  ]);
    manifest.push({ ...item, outputPath, metadataPath, overlayPath, productionCommandPath, overlayCommandPath, validation });
  }

  await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({ source, cases: manifest }, null, 2), 'utf8');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
