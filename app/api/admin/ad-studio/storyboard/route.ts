import { NextResponse } from 'next/server';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import { requireAdmin } from '@/lib/admin-auth';
import { normalizeStoryboard, type AdStoryboard } from '@/lib/ad-storyboard';
import { openai } from '@/lib/openai';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  createSignedR2GetUrl,
  downloadR2Object,
  isR2Configured,
  r2ObjectExists,
  uploadR2Object,
} from '@/lib/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function safeAssetPath(userId: string, value: unknown) {
  const candidate = String(value || '');
  return candidate.startsWith(`${userId}/ad-assets/`) && !candidate.includes('..') ? candidate : null;
}

function storyboardPath(userId: string, assetPath: string) {
  return `${userId}/ad-storyboards/${crypto.createHash('sha256').update(assetPath).digest('hex')}.json`;
}

function mediaCommand() {
  if (process.env.FFMPEG_PATH?.trim()) return process.env.FFMPEG_PATH.trim();
  const bundledPath = path.join(process.cwd(), 'public', 'bin', 'ffmpeg');
  try {
    accessSync(bundledPath, constants.X_OK);
    return bundledPath;
  } catch {
    return ffmpegPath || 'ffmpeg';
  }
}

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-30_000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stderr) : reject(new Error(stderr || `${command} exited with ${code}`)));
  });
}

function parseDuration(stderr: string) {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error('Could not determine the recording duration.');
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('AI returned an invalid storyboard.');
  return JSON.parse(cleaned.slice(first, last + 1));
}

async function resolveAsset(userId: string, assetPath: string) {
  if (isR2Configured() && await r2ObjectExists(assetPath)) {
    return { sourceUrl: await createSignedR2GetUrl(assetPath, 60 * 30), provider: 'r2' as const };
  }
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from('raw-media').createSignedUrl(assetPath, 60 * 30);
  if (error || !data?.signedUrl) throw error || new Error('Saved recording could not be opened.');
  return { sourceUrl: data.signedUrl, provider: 'supabase' as const };
}

async function loadSaved(userId: string, assetPath: string) {
  const key = storyboardPath(userId, assetPath);
  if (!isR2Configured() || !await r2ObjectExists(key)) return null;
  return JSON.parse((await downloadR2Object(key)).toString('utf8')) as AdStoryboard;
}

async function saveStoryboard(userId: string, storyboard: AdStoryboard) {
  if (!isR2Configured()) throw new Error('R2 storage is required to save ad storyboards.');
  await uploadR2Object(
    storyboardPath(userId, storyboard.assetPath),
    Buffer.from(JSON.stringify(storyboard)),
    'application/json',
    'private, no-store',
  );
}

export async function GET(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const assetPath = safeAssetPath(adminUser.id, new URL(request.url).searchParams.get('assetPath'));
  if (!assetPath) return NextResponse.json({ error: 'Choose a valid saved recording.' }, { status: 400 });
  return NextResponse.json({ storyboard: await loadSaved(adminUser.id, assetPath) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json() as { storyboard?: unknown };
  const raw = (body.storyboard && typeof body.storyboard === 'object' ? body.storyboard : {}) as Record<string, unknown>;
  const assetPath = safeAssetPath(adminUser.id, raw.assetPath);
  if (!assetPath) return NextResponse.json({ error: 'Choose a valid saved recording.' }, { status: 400 });
  const storyboard = normalizeStoryboard(raw, { path: assetPath, name: String(raw.assetName || 'Full video demo') }, Number(raw.sourceDuration) || 1);
  await saveStoryboard(adminUser.id, storyboard);
  return NextResponse.json({ storyboard });
}

export async function POST(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json({ error: 'OPENAI_API_KEY is required for footage analysis.' }, { status: 503 });
  }
  const body = await request.json() as { assetPath?: string; assetName?: string; audience?: string; offer?: string; targetDuration?: number };
  const assetPath = safeAssetPath(adminUser.id, body.assetPath);
  if (!assetPath) return NextResponse.json({ error: 'Select the saved Full video demo first.' }, { status: 400 });

  const workdir = await mkdtemp(path.join(tmpdir(), 'animacut-storyboard-'));
  try {
    const { sourceUrl } = await resolveAsset(adminUser.id, assetPath);
    const probe = await run(mediaCommand(), ['-hide_banner', '-i', sourceUrl, '-frames:v', '1', '-f', 'null', '-']);
    const duration = parseDuration(probe);
    const frameCount = 12;
    const timestamps = Array.from({ length: frameCount }, (_, index) => Math.min(duration - 0.1, duration * ((index + 0.5) / frameCount)));

    for (const [index, timestamp] of timestamps.entries()) {
      await run(mediaCommand(), [
        '-y', '-ss', timestamp.toFixed(2), '-i', sourceUrl, '-frames:v', '1',
        '-vf', 'scale=640:-2', '-q:v', '3', path.join(workdir, `frame-${String(index + 1).padStart(2, '0')}.jpg`),
      ]);
    }
    const frameFiles = (await readdir(workdir)).filter((name) => name.endsWith('.jpg')).sort();
    const imageContent = await Promise.all(frameFiles.map(async (name, index) => ({
      type: 'input_image' as const,
      image_url: `data:image/jpeg;base64,${(await readFile(path.join(workdir, name))).toString('base64')}`,
      detail: 'low' as const,
      timestamp: timestamps[index],
    })));
    const targetDuration = [15, 20, 25, 30].includes(Number(body.targetDuration)) ? Number(body.targetDuration) : 20;
    const timestampGuide = timestamps.map((time, index) => `Frame ${index + 1}: ${time.toFixed(1)}s`).join('\n');
    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      store: false,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `You are a direct-response UGC ad editor. Analyze sampled frames from a full screen recording of the AnimaCut workflow.

Create an editable ${targetDuration}-second multi-scene ad storyboard for:
- Audience: ${String(body.audience || 'podcasters and YouTube creators').slice(0, 160)}
- Offer: ${String(body.offer || 'turn one long video into ready-to-post short reels').slice(0, 200)}

Find the strongest workflow beats visible in the samples: source/link entry, starting generation, processing, generated reel results, opening/editing a reel, and export/download. Use only moments supported by the frames. Source timestamps must be plausible and ordered, and each source window should normally be 2–6 seconds. Prefer visual change and proof over waiting/loading screens. The ad must have Hook → Problem → Product action → Proof/result → CTA. Write natural first-person UGC voiceover, not corporate copy.

Return JSON only with:
{
  "angle": string,
  "audience": string,
  "hook": string,
  "voiceoverScript": string,
  "scenes": [{
    "sourceStart": number,
    "sourceEnd": number,
    "adDuration": number,
    "purpose": string,
    "visual": string,
    "onScreenText": string,
    "voiceover": string
  }]
}
Use 5–7 scenes whose adDuration values total approximately ${targetDuration}.

Frame timestamp guide:
${timestampGuide}`,
          },
          ...imageContent.map((image) => ({
            type: image.type,
            image_url: image.image_url,
            detail: image.detail,
          })),
        ],
      }],
    });
    const raw = parseJson(response.output_text);
    const storyboard = normalizeStoryboard(raw, { path: assetPath, name: String(body.assetName || 'Full video demo') }, duration);
    await saveStoryboard(adminUser.id, storyboard);
    return NextResponse.json({ storyboard }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Ad storyboard analysis failed', error);
    const message = error instanceof Error ? error.message : 'Unknown analysis error';
    return NextResponse.json({ error: `Footage analysis failed: ${message.slice(0, 280)}` }, { status: 500 });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
