import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const projectId = process.argv[2]?.trim();
if (!projectId) throw new Error('Usage: npm run previews:backfill -- <project-id>');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error('Missing Supabase admin environment variables');

const storage = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).storage.from('exports');

function runFfmpeg(inputPath, outputPath) {
  const args = [
    '-y', '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=360:640:flags=lanczos,fps=24',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27',
    '-maxrate', '800k', '-bufsize', '1600k', '-pix_fmt', 'yuv420p',
    '-g', '24', '-keyint_min', '12', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', '-ar', '48000',
    '-movflags', '+faststart', outputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr}`)));
  });
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: project, error: projectError } = await admin
  .from('projects')
  .select('id,user_id')
  .eq('id', projectId)
  .single();
if (projectError || !project) throw projectError || new Error('Project not found');

const { data: exports, error: exportsError } = await admin
  .from('exports')
  .select('id,output_storage_path')
  .eq('project_id', projectId)
  .eq('status', 'done')
  .not('output_storage_path', 'is', null);
if (exportsError) throw exportsError;

const objectDirectory = `${project.user_id}/${project.id}`;
const { data: existingObjects, error: listError } = await storage.list(objectDirectory, { limit: 1000 });
if (listError) throw listError;
const existingNames = new Set((existingObjects ?? []).map((item) => item.name));
const pending = (exports ?? []).filter((item) => !existingNames.has(`${item.id}.preview.mp4`));

const tempDirectory = await mkdtemp(path.join(tmpdir(), 'animacut-preview-backfill-'));
try {
  for (const [index, item] of pending.entries()) {
    const inputPath = path.join(tempDirectory, `${item.id}.master.mp4`);
    const outputPath = path.join(tempDirectory, `${item.id}.preview.mp4`);
    const { data: master, error: downloadError } = await storage.download(item.output_storage_path);
    if (downloadError || !master) throw downloadError || new Error(`Could not download ${item.id}`);
    await writeFile(inputPath, Buffer.from(await master.arrayBuffer()));
    await runFfmpeg(inputPath, outputPath);
    const previewBytes = await readFile(outputPath);
    const { error: uploadError } = await storage.upload(`${objectDirectory}/${item.id}.preview.mp4`, previewBytes, {
      upsert: true,
      contentType: 'video/mp4',
      cacheControl: '86400',
    });
    if (uploadError) throw uploadError;
    await rm(inputPath, { force: true });
    await rm(outputPath, { force: true });
    console.log(`Created preview ${index + 1}/${pending.length}`);
  }
  console.log(`Backfill complete: ${pending.length} preview(s) created`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
