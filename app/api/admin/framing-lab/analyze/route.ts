import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { requireAdmin } from '@/lib/admin-auth';
import { createExportDownloadUrl, uploadExportObject } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

type ReframeResult = {
  meta?: {
    track_count?: number;
    speaker_switches?: number;
    frames_with_detection_pct?: number;
    detection_fallback_count?: number;
    timeline_segments?: number;
    layout_modes?: string[];
    debug_overlay_path?: string | null;
  };
  reframe_timeline?: Array<{
    start?: number;
    end?: number;
    mode?: string;
    selection_reason?: string;
    reason?: string;
    active_track_id?: number;
    speaker_confidence?: number;
    points?: Array<{
      active_track_id?: number;
      selection_reason?: string;
      speaker_confidence?: number;
    }>;
  }>;
};

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-5_000_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout || `${command} exited with ${code}`)));
  });
}

function pythonCommand() {
  const candidates = [
    process.env.SMART_REFRAME_PYTHON,
    path.join(process.cwd(), '.venv', 'bin', 'python'),
    'python3',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (candidate === 'python3') return candidate;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next configured runtime.
    }
  }
  return 'python3';
}

function mediaCommand() {
  if (process.env.FFMPEG_PATH?.trim()) return process.env.FFMPEG_PATH.trim();
  const bundled = path.join(process.cwd(), 'public', 'bin', 'ffmpeg');
  try {
    accessSync(bundled, constants.X_OK);
    return bundled;
  } catch {
    return ffmpegPath || 'ffmpeg';
  }
}

async function publish(userId: string, runId: string, name: string, bytes: Buffer) {
  const objectPath = `framing-lab/${userId}/${runId}/${name}`;
  await uploadExportObject(objectPath, bytes);
  return createExportDownloadUrl(objectPath, name, 60 * 60);
}

export async function POST(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const workdir = await mkdtemp(path.join(tmpdir(), 'animacut-framing-lab-'));
  try {
    const form = await request.formData();
    const upload = form.get('file');
    const duration = Math.max(5, Math.min(30, Number(form.get('duration')) || 20));
    if (!(upload instanceof File) || !upload.size) return NextResponse.json({ error: 'Choose a test video.' }, { status: 400 });
    if (upload.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'Framing Lab test videos must be under 300 MB.' }, { status: 413 });

    const inputPath = path.join(workdir, 'input-video');
    const metadataPath = path.join(workdir, 'analysis.json');
    const rawPreviewPath = path.join(workdir, 'preview-silent.mp4');
    const previewPath = path.join(workdir, 'framing-preview.mp4');
    const debugDir = path.join(workdir, 'debug');
    await writeFile(inputPath, Buffer.from(await upload.arrayBuffer()));

    await run(pythonCommand(), [
      path.join(process.cwd(), 'scripts', 'reframe_per_clip.py'),
      inputPath, '0', String(duration), '4',
    ], {
      env: {
        ...process.env,
        SMART_REFRAME_METADATA_PATH: metadataPath,
        SMART_REFRAME_DEBUG_EXPORT: 'true',
        SMART_REFRAME_DEBUG_DIR: debugDir,
        SMART_REFRAME_DEBUG_CLIP_ID: 'lab',
      },
    });

    await run(pythonCommand(), [
      path.join(process.cwd(), 'scripts', 'render_framing_lab.py'),
      inputPath, metadataPath, rawPreviewPath, String(duration),
    ]);
    await run(mediaCommand(), [
      '-y', '-i', rawPreviewPath, '-i', inputPath, '-map', '0:v:0', '-map', '1:a:0?',
      '-t', String(duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', previewPath,
    ]);

    const analysis = JSON.parse(await readFile(metadataPath, 'utf8')) as ReframeResult;
    const runId = crypto.randomUUID();
    const [originalUrl, previewUrl] = await Promise.all([
      publish(user.id, runId, 'original.mp4', await readFile(inputPath)),
      publish(user.id, runId, 'framing-preview.mp4', await readFile(previewPath)),
    ]);
    const debugPath = analysis.meta?.debug_overlay_path;
    let debugUrl: string | null = null;
    if (debugPath) {
      try {
        debugUrl = await publish(user.id, runId, 'framing-debug.mp4', await readFile(debugPath));
      } catch {
        debugUrl = null;
      }
    }

    const decisions = (analysis.reframe_timeline || []).map((segment) => {
      const point = segment.points?.[0];
      return {
        start: Number(segment.start || 0),
        end: Number(segment.end || duration),
        mode: String(segment.mode || 'single'),
        reason: String(segment.selection_reason || segment.reason || point?.selection_reason || 'speaker continuity'),
        activeTrackId: segment.active_track_id ?? point?.active_track_id ?? null,
        confidence: Number(segment.speaker_confidence ?? point?.speaker_confidence ?? 0),
      };
    });

    return NextResponse.json({
      originalUrl,
      previewUrl,
      debugUrl,
      fileName: `framing-test-${runId.slice(0, 8)}.mp4`,
      metrics: {
        duration,
        trackCount: Number(analysis.meta?.track_count || 0),
        speakerSwitches: Number(analysis.meta?.speaker_switches || 0),
        detectionRate: Number(analysis.meta?.frames_with_detection_pct || 0),
        fallbackCount: Number(analysis.meta?.detection_fallback_count || 0),
        timelineSegments: Number(analysis.meta?.timeline_segments || decisions.length),
        layoutModes: analysis.meta?.layout_modes || [],
      },
      decisions,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[framing-lab]', error);
    const detail = error instanceof Error ? error.message : '';
    const missingRuntime = /dependency_unavailable|No module named|ENOENT/i.test(detail);
    return NextResponse.json({
      error: missingRuntime
        ? 'The framing analysis runtime is not installed on this server. Run npm run reframe:setup on the AnimaCut worker host.'
        : 'Framing analysis failed. Try a shorter MP4 with clearly visible speakers.',
    }, { status: 500 });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
