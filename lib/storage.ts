import path from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createAdminClient } from '@/lib/supabase/admin';
import { createR2PublicUrl, createSignedR2GetUrl, deleteR2Object, deleteR2PreviewObject, getR2Config, getUploadProvider, isR2Configured, r2ObjectExists, r2PreviewObjectExists, uploadR2PreviewObject } from '@/lib/r2';

const RAW_BUCKET = 'raw-media';
const EXPORT_BUCKET = 'exports';
const PROJECT_THUMBNAIL_BUCKET = 'exports';

async function removeSupabaseObjects(bucket: string, objectPaths: string[]) {
  const paths = [...new Set(objectPaths.filter(Boolean))];
  if (!paths.length) return;

  const admin = createAdminClient();
  for (let index = 0; index < paths.length; index += 100) {
    const { error } = await admin.storage.from(bucket).remove(paths.slice(index, index + 100));
    if (error) throw error;
  }
}

export function makeRawObjectPath(userId: string, projectId: string, ext: string) {
  return `${userId}/${projectId}/source.${ext.toLowerCase()}`;
}

export function makeExportObjectPath(userId: string, projectId: string, exportId: string) {
  return `${userId}/${projectId}/${exportId}.mp4`;
}

export function makeExportPreviewObjectPath(userId: string, projectId: string, exportId: string) {
  return `${userId}/${projectId}/${exportId}.preview.mp4`;
}

export function makeAdaptiveExportPreviewObjectPath(userId: string, projectId: string, exportId: string, quality: '360p' | '540p', version = 'v1') {
  return `previews/${userId}/${projectId}/${exportId}/${version}.${quality}.mp4`;
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
    // Signed URLs already protect access. Allow the browser/CDN to reuse the
    // same reel while users switch between clips instead of fetching it again.
    cacheControl: '3600',
  });
  if (error) throw error;
}

export async function uploadExportPreviewObject(objectPath: string, bytes: Buffer) {
  if (isR2Configured() && getR2Config()?.publicBaseUrl) {
    await uploadR2PreviewObject(objectPath, bytes, 'video/mp4');
    return { provider: 'r2' as const, path: objectPath, url: createR2PublicUrl(objectPath) };
  }
  const admin = createAdminClient();
  const { error } = await admin.storage.from(EXPORT_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType: 'video/mp4',
    cacheControl: '86400',
  });
  if (error) throw error;
  return { provider: 'supabase' as const, path: objectPath, url: null };
}

export async function exportPreviewObjectExists(provider: 'r2' | 'supabase', objectPath: string) {
  if (provider === 'r2') return isR2Configured() ? r2PreviewObjectExists(objectPath) : false;
  const directory = objectPath.split('/').slice(0, -1).join('/');
  const name = objectPath.split('/').pop();
  const admin = createAdminClient();
  const { data } = await admin.storage.from(EXPORT_BUCKET).list(directory, { search: name, limit: 1 });
  return Boolean(name && data?.some((item) => item.name === name));
}

export async function createExportPreviewUrl(provider: 'r2' | 'supabase', objectPath: string, expiresIn = 60 * 60) {
  if (provider === 'r2') return createR2PublicUrl(objectPath) || createSignedR2GetUrl(objectPath, expiresIn);
  return createExportSignedUrl(objectPath, expiresIn);
}

export async function uploadExportThumbnailObject(objectPath: string, bytes: Buffer) {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(EXPORT_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType: 'image/jpeg',
    cacheControl: '3600',
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

export async function findExistingExportObjectPaths(objectPaths: string[]) {
  const paths = [...new Set(objectPaths.filter(Boolean))];
  const existing = new Set<string>();
  if (paths.length === 0) return existing;

  const pathsByDirectory = new Map<string, string[]>();
  for (const objectPath of paths) {
    const parts = objectPath.split('/');
    const fileName = parts.pop();
    if (!fileName) continue;
    const directory = parts.join('/');
    pathsByDirectory.set(directory, [...(pathsByDirectory.get(directory) ?? []), fileName]);
  }

  const admin = createAdminClient();
  await Promise.all([...pathsByDirectory.entries()].map(async ([directory, fileNames]) => {
    const wanted = new Set(fileNames);
    const { data, error } = await admin.storage.from(EXPORT_BUCKET).list(directory, {
      limit: Math.max(100, wanted.size * 3),
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw error;

    for (const item of data ?? []) {
      if (wanted.has(item.name)) existing.add(directory ? `${directory}/${item.name}` : item.name);
    }
  }));

  return existing;
}

export async function createExportSignedUrls(objectPaths: string[], expiresIn = 60 * 60) {
  const paths = [...new Set(objectPaths.filter(Boolean))];
  const signedUrls = new Map<string, string>();
  if (paths.length === 0) return signedUrls;

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(EXPORT_BUCKET).createSignedUrls(paths, expiresIn);
  if (error) throw error;

  for (const item of data ?? []) {
    if (item.path && item.signedUrl) signedUrls.set(item.path, item.signedUrl);
  }

  return signedUrls;
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

export async function deleteRawMediaObjects(objectPaths: string[]) {
  await removeSupabaseObjects(RAW_BUCKET, objectPaths);
}

export async function deleteExportObjects(objectPaths: string[]) {
  await removeSupabaseObjects(EXPORT_BUCKET, objectPaths);
}

export async function deleteR2PreviewObjects(objectPaths: string[]) {
  if (!isR2Configured()) return;
  await Promise.all([...new Set(objectPaths.filter(Boolean))].map((objectPath) => deleteR2PreviewObject(objectPath)));
}
