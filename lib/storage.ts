import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createAdminClient } from '@/lib/supabase/admin';
import { createSignedR2GetUrl, getUploadProvider, isR2Configured, r2ObjectExists } from '@/lib/r2';

const RAW_BUCKET = 'raw-media';
const EXPORT_BUCKET = 'exports';
const PROJECT_THUMBNAIL_BUCKET = 'exports';

export function makeRawObjectPath(userId: string, projectId: string, ext: string) {
  return `${userId}/${projectId}/source.${ext.toLowerCase()}`;
}

export function makeExportObjectPath(userId: string, projectId: string, exportId: string) {
  return `${userId}/${projectId}/${exportId}.mp4`;
}

export function makeExportThumbnailObjectPath(userId: string, projectId: string, exportId: string) {
  return `${userId}/${projectId}/${exportId}.jpg`;
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
    cacheControl: '0',
  });
  if (error) throw error;
}

export async function uploadExportThumbnailObject(objectPath: string, bytes: Buffer) {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(EXPORT_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType: 'image/jpeg',
    cacheControl: '0',
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
  const ext = path.extname(objectPath) || '.mp4';
  const dir = path.join(process.cwd(), 'tmp', 'ingest', projectId);
  await mkdir(dir, { recursive: true });
  const localPath = path.join(dir, `source${ext}`);

  try {
    const existing = await stat(localPath);
    if (existing.size > 0) return localPath;
  } catch {
    // no cached source yet
  }

  let bytes: Buffer;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (getUploadProvider() === 'r2' && isR2Configured()) {
        const signedUrl = await createSignedR2GetUrl(objectPath, 60 * 60);
        const res = await fetch(signedUrl);
        if (!res.ok) {
          const bodyPreview = await res.text().catch(() => '');
          throw new Error(
            `Failed to download raw media from R2: status=${res.status} key=${objectPath} url=${signedUrl.split('?')[0]} body=${bodyPreview.slice(0, 200)}`,
          );
        }
        bytes = Buffer.from(await res.arrayBuffer());
      } else {
        const admin = createAdminClient();
        const { data, error } = await admin.storage.from(RAW_BUCKET).download(objectPath);
        if (error || !data) throw error || new Error('Failed to download raw media');
        bytes = Buffer.from(await data.arrayBuffer());
      }

      await writeFile(localPath, bytes);
      return localPath;
    } catch (error) {
      if (attempt >= 3) {
        const message = error instanceof Error ? error.message : 'Unknown storage error';
        throw new Error(`Upload source file could not be read from storage after retries. ${message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }

  throw new Error('Upload source file could not be read from storage.');
}

export async function rawMediaObjectExists(objectPath: string) {
  if (getUploadProvider() === 'r2' && isR2Configured()) {
    return await r2ObjectExists(objectPath);
  }

  const admin = createAdminClient();
  const { data } = await admin.storage.from(RAW_BUCKET).list(objectPath.split('/').slice(0, -1).join('/'), {
    search: objectPath.split('/').pop(),
    limit: 1,
  });

  return Boolean(data?.some((item) => item.name === objectPath.split('/').pop()));
}

export async function projectThumbnailObjectExists(objectPath: string) {
  const admin = createAdminClient();
  const { data } = await admin.storage.from(PROJECT_THUMBNAIL_BUCKET).list(objectPath.split('/').slice(0, -1).join('/'), {
    search: objectPath.split('/').pop(),
    limit: 1,
  });

  return Boolean(data?.some((item) => item.name === objectPath.split('/').pop()));
}

export async function createExportSignedUrl(objectPath: string, expiresIn = 60 * 60) {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(EXPORT_BUCKET).createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function createRawMediaSignedUrl(objectPath: string, expiresIn = 60 * 60) {
  if (getUploadProvider() === 'r2' && isR2Configured()) {
    return createSignedR2GetUrl(objectPath, expiresIn);
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(RAW_BUCKET).createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

export async function createProjectThumbnailSignedUrl(objectPath: string, expiresIn = 60 * 60 * 24 * 7) {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(PROJECT_THUMBNAIL_BUCKET).createSignedUrl(objectPath, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}
