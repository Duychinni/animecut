import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createAdminClient } from '@/lib/supabase/admin';

const RAW_BUCKET = 'raw-media';
const EXPORT_BUCKET = 'exports';
const PROJECT_THUMBNAIL_BUCKET = 'exports';

export function makeRawObjectPath(userId: string, projectId: string, ext: string) {
  return `${userId}/${projectId}/source.${ext.toLowerCase()}`;
}

export function makeExportObjectPath(userId: string, projectId: string, exportId: string) {
  return `${userId}/${projectId}/${exportId}.mp4`;
}

export function makeProjectThumbnailObjectPath(userId: string, projectId: string) {
  return `${userId}/${projectId}/project-thumbnail.jpg`;
}

export async function uploadRawMediaObject(objectPath: string, bytes: Buffer, contentType: string) {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(RAW_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType,
  });
  if (error) throw error;
}

export async function uploadExportObject(objectPath: string, bytes: Buffer) {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(EXPORT_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType: 'video/mp4',
  });
  if (error) throw error;
}

export async function uploadProjectThumbnailObject(objectPath: string, bytes: Buffer) {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(PROJECT_THUMBNAIL_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType: 'image/jpeg',
  });
  if (error) throw error;
}

export async function downloadRawMediaToLocal(objectPath: string, projectId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(RAW_BUCKET).download(objectPath);
  if (error || !data) throw error || new Error('Failed to download raw media');

  const bytes = Buffer.from(await data.arrayBuffer());
  const ext = path.extname(objectPath) || '.mp4';
  const dir = path.join(process.cwd(), 'tmp', 'ingest', projectId);
  await mkdir(dir, { recursive: true });
  const localPath = path.join(dir, `source${ext}`);
  await writeFile(localPath, bytes);

  return localPath;
}

export async function createExportSignedUrl(objectPath: string, expiresIn = 60 * 60) {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(EXPORT_BUCKET).createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function createProjectThumbnailSignedUrl(objectPath: string, expiresIn = 60 * 60 * 24 * 7) {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(PROJECT_THUMBNAIL_BUCKET).createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}
