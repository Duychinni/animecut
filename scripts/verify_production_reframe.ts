import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderVerticalClip, validateRenderedVideo } from '../lib/ffmpeg';

const source = process.argv[2];
const outputDir = process.argv[3];
if (!source || !outputDir) {
  throw new Error('usage: verify_production_reframe.ts <source> <output-dir> [start-sec end-sec case-id]');
}

const customStart = Number(process.argv[4]);
const customEnd = Number(process.argv[5]);
const customId = process.argv[6] || 'dynamic_conversation';
const cases = Number.isFinite(customStart) && Number.isFinite(customEnd) && customEnd > customStart
  ? [{ id: customId, start: customStart, end: customEnd }]
  : [
      { id: 'A_far_left', start: 267, end: 274 },
      { id: 'B_far_right', start: 336, end: 343 },
      { id: 'C_centered', start: 8, end: 15 },
      { id: 'D_two_visible', start: 0, end: 8 },
      { id: 'E_profile_turn', start: 72, end: 82 },
      { id: 'F_temporary_occlusion', start: 18, end: 27 },
      { id: 'G_hard_camera_cut', start: 8, end: 15 },
    ];

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
    process.env.DEBUG_REFRAME_SAVE_JSON = 'true';

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
    const debugDir = process.env.SMART_REFRAME_DEBUG_DIR?.trim() || path.join(process.cwd(), 'tmp', 'reframe-debug');
    const productionCommandPath = path.join(outputDir, `${item.id}.production.ffmpeg-command.txt`);
    const productionFilterPath = path.join(outputDir, `${item.id}.production.filter-graph.txt`);
    const productionBundlePath = path.join(outputDir, `${item.id}.production.bundle.json`);
    await copyFile(path.join(debugDir, `${item.id}.ffmpeg-command.txt`), productionCommandPath);
    await copyFile(path.join(debugDir, `${item.id}.filter-graph.txt`), productionFilterPath);
    await copyFile(path.join(debugDir, `${item.id}.bundle.json`), productionBundlePath);

    await run(process.env.SMART_REFRAME_PYTHON || 'python', [
      path.join(process.cwd(), 'scripts', 'reframe_debug_overlay.py'),
      source,
      metadataPath,
      String(item.start),
      String(item.end),
      overlayPath,
      overlayCommandPath,
    ]);

    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
      meta?: Record<string, unknown>;
      reframe_timeline?: Array<Record<string, unknown>>;
    };
    const timeline = metadata.reframe_timeline ?? [];
    const report = {
      source,
      case: item,
      validation,
      detections: metadata.meta?.detection_count ?? null,
      tracks: metadata.meta?.track_count ?? null,
      trackSwitches: metadata.meta?.track_switches ?? null,
      sceneCuts: metadata.meta?.scene_cuts ?? null,
      layoutModeChanges: metadata.meta?.layout_mode_changes ?? null,
      detectionFallbackCount: metadata.meta?.detection_fallback_count ?? null,
      framesUsingPrediction: metadata.meta?.samples_using_prediction ?? null,
      analysisRateFps: metadata.meta?.analysis_rate_fps ?? null,
      timelineSegments: timeline.length,
      modes: timeline.map((segment) => segment.mode),
      acceptance: {
        hasMultipleTimedDecisions: timeline.length > 1,
        hasSingleSpeaker: timeline.some((segment) => segment.mode === 'single'),
        hasStackedTwoPerson: timeline.some((segment) => segment.mode === 'stacked'),
        noSubSecondLayoutFlicker: timeline.every((segment) => Number(segment.end) - Number(segment.start) >= 0.9),
        outputIs1080x1920: validation.width === 1080 && validation.height === 1920,
        outputIsH264: validation.videoCodec === 'h264',
        outputIsYuv420p: validation.pixelFormat === 'yuv420p',
        hasSynchronizedAudio: Boolean(validation.audioCodec),
      },
    };
    const reportPath = path.join(outputDir, `${item.id}.test-report.json`);
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    manifest.push({
      ...item,
      outputPath,
      metadataPath,
      overlayPath,
      productionCommandPath,
      productionFilterPath,
      productionBundlePath,
      overlayCommandPath,
      reportPath,
      validation,
    });
  }

  await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({ source, cases: manifest }, null, 2), 'utf8');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
