import { access } from 'node:fs/promises';
import { downloadYouTubeVideo } from '@/lib/youtube';
import { downloadRawMediaToLocal } from '@/lib/storage';

type ProjectRow = {
  id: string;
  source_type: 'youtube' | 'upload';
  source_url?: string | null;
  source_storage_path?: string | null;
};

export async function resolveProjectVideoSource(project: ProjectRow) {
  if (project.source_type === 'upload') {
    if (!project.source_storage_path) {
      throw new Error('Upload project missing source_storage_path');
    }

    if (project.source_storage_path.startsWith('/') || project.source_storage_path.startsWith('.')) {
      await access(project.source_storage_path);
      return project.source_storage_path;
    }

    return downloadRawMediaToLocal(project.source_storage_path, project.id);
  }

  if (!project.source_url) {
    throw new Error('YouTube project missing source_url');
  }

  if (project.source_storage_path) {
    return downloadRawMediaToLocal(project.source_storage_path, project.id);
  }

  return downloadYouTubeVideo(project.source_url, project.id);
}
