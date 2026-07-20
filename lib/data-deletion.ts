import { cleanupProjectTempFiles } from '@/lib/cleanup';
import { deleteProjectAnalysisArtifacts } from '@/lib/media-intelligence/storage';
import { deleteR2Object, isR2Configured } from '@/lib/r2';
import {
  deleteExportObjects,
  deleteRawMediaObjects,
  makeExportPreviewObjectPath,
  makeExportThumbnailObjectPath,
  makeProjectThumbnailObjectPath,
} from '@/lib/storage';
import { createAdminClient } from '@/lib/supabase/admin';

type ProjectDeletionRow = {
  id: string;
  user_id: string;
  source_storage_path: string | null;
};

function unique(paths: Array<string | null | undefined>) {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function derivedExportPaths(userId: string, projectId: string, exportRows: Array<{ id: string; output_storage_path: string | null }>) {
  return unique(exportRows.flatMap((row) => [
    row.output_storage_path,
    makeExportPreviewObjectPath(userId, projectId, row.id),
    makeExportThumbnailObjectPath(userId, projectId, row.id),
  ]).concat(makeProjectThumbnailObjectPath(userId, projectId)));
}

export async function deleteProjectAndArtifacts(project: ProjectDeletionRow) {
  const admin = createAdminClient();
  const { data: exportRows, error: exportError } = await admin
    .from('exports')
    .select('id, output_storage_path')
    .eq('project_id', project.id);
  if (exportError) throw exportError;

  const rawPaths = unique([project.source_storage_path]);
  const exportPaths = derivedExportPaths(project.user_id, project.id, exportRows ?? []);

  // Try both raw-media backends so changing UPLOAD_PROVIDER does not orphan
  // objects written by the previous provider.
  await deleteRawMediaObjects(rawPaths);
  if (isR2Configured()) {
    for (const objectPath of rawPaths) await deleteR2Object(objectPath);
  }
  await deleteExportObjects(exportPaths);
  await deleteProjectAnalysisArtifacts(project.id);

  const { error: deleteError } = await admin
    .from('projects')
    .delete()
    .eq('id', project.id)
    .eq('user_id', project.user_id);
  if (deleteError) throw deleteError;

  await cleanupProjectTempFiles(project.id);
  return { raw_objects: rawPaths.length, export_objects: exportPaths.length };
}

export async function deleteUserProjectsAndArtifacts(userId: string) {
  const admin = createAdminClient();
  const { data: projects, error } = await admin
    .from('projects')
    .select('id, user_id, source_storage_path')
    .eq('user_id', userId);
  if (error) throw error;

  let rawObjects = 0;
  let exportObjects = 0;
  for (const project of projects ?? []) {
    const result = await deleteProjectAndArtifacts(project);
    rawObjects += result.raw_objects;
    exportObjects += result.export_objects;
  }
  return { projects: projects?.length ?? 0, raw_objects: rawObjects, export_objects: exportObjects };
}
