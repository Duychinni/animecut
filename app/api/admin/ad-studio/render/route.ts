import { NextResponse } from 'next/server';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { requireAdmin } from '@/lib/admin-auth';
import { AD_STUDIO_MAX_UPLOAD_BYTES, isAllowedAdStudioUpload } from '@/lib/ad-studio-upload';
import { createExportDownloadUrl, uploadExportObject } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ALLOWED_REELS = new Set(['creator', 'mrbeast', 'companies', 'intermediate', 'capacity', 'audience']);
const COLORS: Record<string, string> = { pink: '&H00C84FFF', yellow: '&H0000FFFF', green: '&H005AF421', purple: '&H00F755A8' };

function clean(value: FormDataEntryValue | null, max: number) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

function assText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}');
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} exited with ${code}`)));
  });
}

function mediaCommand() {
  return process.env.FFMPEG_PATH?.trim() || ffmpegPath || 'ffmpeg';
}

function subtitleFile(hook: string, support: string, cta: string, accent: string, duration: number) {
  const end = `0:00:${duration.toFixed(2).padStart(5, '0')}`;
  const supportStart = Math.min(3, Math.max(1.5, duration * 0.18)).toFixed(2).padStart(5, '0');
  const ctaStart = Math.max(5, duration - 4).toFixed(2).padStart(5, '0');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,Montserrat,76,&H00FFFFFF,&H00FFFFFF,&H00000000,&H70000000,-1,0,0,0,100,100,0,0,1,6,2,8,90,90,145,1
Style: Support,Montserrat,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,3,2,0,2,90,90,285,1
Style: CTA,Montserrat,48,&H00000000,&H00000000,${accent},${accent},-1,0,0,0,100,100,0,0,3,2,0,2,260,260,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${end},Hook,,0,0,0,,${assText(hook)}
Dialogue: 0,0:00:${supportStart},${end},Support,,0,0,0,,${assText(support)}
Dialogue: 1,0:00:${ctaStart},${end},CTA,,0,0,0,,${assText(cta)}
`;
}

export async function POST(request: Request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const workdir = await mkdtemp(path.join(tmpdir(), 'animacut-ad-'));
  try {
    const form = await request.formData();
    const hook = clean(form.get('hook'), 80);
    const support = clean(form.get('support'), 160);
    const cta = clean(form.get('cta'), 40);
    const reel = clean(form.get('reel'), 30);
    const palette = clean(form.get('palette'), 20);
    const campaign = clean(form.get('campaign'), 48).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'ad';
    const requestedDuration = Number(form.get('duration'));
    const duration = [15, 20, 25].includes(requestedDuration) ? requestedDuration : 15;
    if (!hook || !cta) return NextResponse.json({ error: 'Hook and CTA are required' }, { status: 400 });

    const upload = form.get('file');
    let inputPath: string;
    if (upload instanceof File && upload.size > 0) {
      if (upload.size > AD_STUDIO_MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'Uploaded footage must be under 300 MB' }, { status: 413 });
      if (!isAllowedAdStudioUpload(upload)) {
        return NextResponse.json({ error: 'Choose an OBS video in MP4, MOV, WebM, MKV, or FLV format.' }, { status: 415 });
      }
      inputPath = path.join(workdir, 'input-video');
      await writeFile(inputPath, Buffer.from(await upload.arrayBuffer()));
      try {
        await run(mediaCommand(), ['-v', 'error', '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-']);
      } catch {
        return NextResponse.json({ error: 'This recording does not contain a readable video stream. Try remuxing it to MP4 in OBS.' }, { status: 415 });
      }
    } else {
      if (!ALLOWED_REELS.has(reel)) return NextResponse.json({ error: 'Choose valid footage' }, { status: 400 });
      inputPath = path.join(process.cwd(), 'public', 'hero-reels', `${reel}.mp4`);
    }

    const subtitlePath = path.join(workdir, 'creative.ass');
    const outputPath = path.join(workdir, 'animacut-ad.mp4');
    await writeFile(subtitlePath, subtitleFile(hook, support, cta, COLORS[palette] || COLORS.pink, duration));

    const escapedAss = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const filter = `[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=36[blur];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[front];[blur][front]overlay=(W-w)/2:(H-h)/2,subtitles='${escapedAss}'[v]`;
    await run(mediaCommand(), [
      '-y', '-stream_loop', '-1', '-i', inputPath, '-t', String(duration),
      '-filter_complex', filter, '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-af', `apad=pad_dur=${duration}`, '-movflags', '+faststart', '-shortest', outputPath,
    ]);
    // Vercel function responses are limited to a few megabytes, while a
    // campaign-ready ad is commonly 8–20 MB. Put the completed render in the
    // existing private exports bucket and return a short-lived download URL.
    const bytes = await readFile(outputPath);
    const renderId = crypto.randomUUID();
    const objectPath = `ad-studio/${adminUser.id}/${campaign}/${renderId}.mp4`;
    const fileName = `animacut-${campaign}-${renderId.slice(0, 8)}.mp4`;
    await uploadExportObject(objectPath, bytes);
    const downloadUrl = await createExportDownloadUrl(objectPath, fileName, 60 * 60);
    return NextResponse.json({ downloadUrl, fileName }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Ad render failed', error);
    return NextResponse.json({ error: 'Ad render failed. Check the footage and try again.' }, { status: 500 });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
