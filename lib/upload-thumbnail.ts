import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createAdminClient } from '@/lib/supabase/admin';
import { extractVideoThumbnail } from '@/lib/ffmpeg';
import { resolveProjectVideoSource } from '@/lib/source';
import {
  createProjectThumbnailSignedUrl,
  makeProjectThumbnailObjectPath,
  projectThumbnailObjectExists,
  uploadProjectThumbnailObject,
} from '@/lib/storage';

type UploadThumbnailProject = {
  id: string;
  user_id: string;
  source_type?: string | null;
  source_storage_path?: string | null;
};

const attemptedThumbnailGeneration = new Set<string>();
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

async function signExistingThumbnail(project: UploadThumbnailProject) {
  const objectPath = makeProjectThumbnailObjectPath(project.user_id, project.id);
  const exists = await projectThumbnailObjectExists(objectPath);
  if (!exists) return null;

  const signedUrl = await createProjectThumbnailSignedUrl(objectPath);
  await createAdminClient()
    .from('projects')
    .update({ source_thumbnail_url: signedUrl, updated_at: new Date().toISOString() })
    .eq('id', project.id);
  return signedUrl;
}

export async function ensureProjectUploadThumbnail(
  project: UploadThumbnailProject,
  options: { generateIfMissing?: boolean; localInputPath?: string | null } = {},
) {
  if (project.source_type !== 'upload' || !project.source_storage_path || !project.user_id) return null;

  const existingUrl = await signExistingThumbnail(project);
  if (existingUrl) return existingUrl;
  if (options.generateIfMissing === false) return null;

  const sourceExt = path.extname(project.source_storage_path).toLowerCase();
  if (sourceExt && !VIDEO_EXTENSIONS.has(sourceExt)) return null;
  if (attemptedThumbnailGeneration.has(project.id)) return null;
  attemptedThumbnailGeneration.add(project.id);

  try {
    const inputPath = options.localInputPath || await resolveProjectVideoSource({
      id: project.id,
      source_type: 'upload',
      source_storage_path: project.source_storage_path,
    });

    const dir = path.join(process.cwd(), 'tmp', 'thumbnails', project.id);
    await mkdir(dir, { recursive: true });
    const thumbnailPath = path.join(dir, 'project-thumbnail.jpg');
    let extracted = false;

    for (const second of [5, 1, 0.2]) {
      try {
        await extractVideoThumbnail(inputPath, thumbnailPath, second);
        extracted = true;
        break;
      } catch (error) {
        console.warn('[upload-thumbnail] extract attempt failed', {
          project_id: project.id,
          second,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!extracted) return null;

    const bytes = Buffer.from(await readFile(thumbnailPath));
    const objectPath = makeProjectThumbnailObjectPath(project.user_id, project.id);
    await uploadProjectThumbnailObject(objectPath, bytes);
    return await signExistingThumbnail(project);
  } finally {
    // This is an in-flight guard, not a permanent failure cache. A transient
    // FFmpeg/storage error must be allowed to retry on the next worker pass.
    attemptedThumbnailGeneration.delete(project.id);
  }
}
