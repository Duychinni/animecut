import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const projectId = process.argv[2]?.trim() || null;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_PREVIEW_BUCKET || process.env.R2_BUCKET;
if (!url || !serviceKey) throw new Error('Missing Supabase admin environment variables');
if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error('Missing R2 environment variables');

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const storage = admin.storage.from('exports');
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});

function profile(quality) {
  return quality === '360p'
    ? { scale: '360:640', fps: '24', crf: '25', maxrate: '950k', bufsize: '1900k', audio: '80k', gop: '48', minGop: '24' }
    : { scale: '540:960', fps: '30', crf: '23', maxrate: '2500k', bufsize: '5000k', audio: '128k', gop: '60', minGop: '30' };
}

function runFfmpeg(inputPath, outputPath, quality) {
  const p = profile(quality);
  const args = [
    '-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=${p.scale}:flags=lanczos+accurate_rnd+full_chroma_int,fps=${p.fps}`,
    '-c:v', 'libx264', '-preset', process.env.FFMPEG_PREVIEW_X264_PRESET || 'veryfast', '-crf', p.crf,
    '-maxrate', p.maxrate, '-bufsize', p.bufsize, '-pix_fmt', 'yuv420p',
    '-g', p.gop, '-keyint_min', p.minGop, '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', p.audio, '-ar', '48000', '-movflags', '+faststart', outputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)));
  });
}

let query = admin
  .from('exports')
  .select('id,project_id,output_storage_path,preview_360_storage_path,preview_540_storage_path,projects!inner(user_id)')
  .eq('status', 'done')
  .not('output_storage_path', 'is', null)
  .order('created_at', { ascending: true });
if (projectId) query = query.eq('project_id', projectId);
const { data: rows, error } = await query;
if (error) throw error;
const pending = [];
for (const row of rows ?? []) {
  let complete = Boolean(row.preview_360_storage_path && row.preview_540_storage_path);
  if (complete) {
    try {
      await Promise.all([
        r2.send(new HeadObjectCommand({ Bucket: bucket, Key: row.preview_360_storage_path })),
        r2.send(new HeadObjectCommand({ Bucket: bucket, Key: row.preview_540_storage_path })),
      ]);
    } catch {
      complete = false;
    }
  }
  if (!complete) pending.push(row);
}
console.log(`Adaptive preview backfill: ${pending.length}/${rows?.length ?? 0} reels pending`);

const tempDirectory = await mkdtemp(path.join(tmpdir(), 'animacut-preview-backfill-'));
try {
  let completed = 0;
  let cursor = 0;
  async function processNext() {
    const index = cursor++;
    if (index >= pending.length) return;
    const item = pending[index];
    const userId = Array.isArray(item.projects) ? item.projects[0]?.user_id : item.projects?.user_id;
    if (!userId) throw new Error(`Missing project owner for ${item.id}`);
    const inputPath = path.join(tempDirectory, `${item.id}.master.mp4`);
    const out360 = path.join(tempDirectory, `${item.id}.360p.mp4`);
    const out540 = path.join(tempDirectory, `${item.id}.540p.mp4`);
    const { data: master, error: downloadError } = await storage.download(item.output_storage_path);
    if (downloadError || !master) throw downloadError || new Error(`Could not download ${item.id}`);
    await writeFile(inputPath, Buffer.from(await master.arrayBuffer()));
    await Promise.all([runFfmpeg(inputPath, out360, '360p'), runFfmpeg(inputPath, out540, '540p')]);
    const [bytes360, bytes540] = await Promise.all([readFile(out360), readFile(out540)]);
    const version = 'backfill-v2';
    const key360 = `previews/${userId}/${item.project_id}/${item.id}/${version}.360p.mp4`;
    const key540 = `previews/${userId}/${item.project_id}/${item.id}/${version}.540p.mp4`;
    await Promise.all([
      r2.send(new PutObjectCommand({ Bucket: bucket, Key: key360, Body: bytes360, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000, immutable' })),
      r2.send(new PutObjectCommand({ Bucket: bucket, Key: key540, Body: bytes540, ContentType: 'video/mp4', CacheControl: 'public, max-age=31536000, immutable' })),
    ]);
    const { error: updateError } = await admin.from('exports').update({
      preview_storage_provider: 'r2',
      preview_360_storage_path: key360,
      preview_540_storage_path: key540,
      preview_360_size_bytes: bytes360.byteLength,
      preview_540_size_bytes: bytes540.byteLength,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id);
    if (updateError) throw updateError;
    await Promise.all([rm(inputPath, { force: true }), rm(out360, { force: true }), rm(out540, { force: true })]);
    completed += 1;
    console.log(`Created adaptive previews ${completed}/${pending.length} (${item.id})`);
    await processNext();
  }
  const concurrency = Math.max(1, Math.min(3, Number(process.env.PREVIEW_BACKFILL_CONCURRENCY || 2)));
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => processNext()));
  console.log(`Backfill complete: ${pending.length} reel(s)`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
