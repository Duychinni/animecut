import path from 'node:path';
import { rm, readdir, stat } from 'node:fs/promises';

type CleanupLog = {
  deleted: string[];
  bytesReclaimed: number;
  errors: string[];
};

function createLog(): CleanupLog {
  return { deleted: [], bytesReclaimed: 0, errors: [] };
}

async function safeStat(targetPath: string) {
  try {
    return await stat(targetPath);
  } catch {
    return null;
  }
}

async function dirSize(targetPath: string): Promise<number> {
  const info = await safeStat(targetPath);
  if (!info) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  const entries = await readdir(targetPath, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => dirSize(path.join(targetPath, entry.name))));
  return nested.reduce((sum, value) => sum + value, 0);
}

export async function deletePathIfExists(targetPath: string, log: CleanupLog) {
  const size = await dirSize(targetPath);
  try {
    await rm(targetPath, { recursive: true, force: true });
    if (size > 0) {
      log.deleted.push(targetPath);
      log.bytesReclaimed += size;
    }
  } catch (error) {
    log.errors.push(`${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function cleanupProjectTempFiles(projectId: string) {
  const log = createLog();
  const baseTmp = path.join(process.cwd(), 'tmp');
  const paths = [
    path.join(baseTmp, 'exports', projectId),
    path.join(baseTmp, 'ingest', projectId),
    path.join(baseTmp, 'repair-checks', projectId),
    path.join(baseTmp, 'thumbs', projectId),
    path.join(baseTmp, 'transcripts', projectId),
  ];

  for (const targetPath of paths) {
    await deletePathIfExists(targetPath, log);
  }

  return log;
}

export async function cleanupExportTempFiles(projectId: string, exportId: string) {
  const log = createLog();
  const exportDir = path.join(process.cwd(), 'tmp', 'exports', projectId);
  const paths = [
    path.join(exportDir, `${exportId}.mp4`),
    path.join(exportDir, `${exportId}.ass`),
    path.join(exportDir, `${exportId}.srt`),
    path.join(exportDir, `${exportId}.mp4.trf`),
    path.join(exportDir, `${exportId}.mp4.hook.txt`),
  ];

  for (const targetPath of paths) {
    await deletePathIfExists(targetPath, log);
  }

  return log;
}

export async function cleanupTmpRootOlderThan(hours: number, protectedProjectIds: ReadonlySet<string> = new Set()) {
  const log = createLog();
  const cutoffMs = Date.now() - hours * 60 * 60 * 1000;
  const tmpRoot = path.join(process.cwd(), 'tmp');
  const buckets = ['ingest', 'exports', 'repair-checks', 'thumbs', 'transcripts'];

  for (const bucket of buckets) {
    const bucketPath = path.join(tmpRoot, bucket);
    let entries = [] as Array<{ name: string }>;
    try {
      const dirEntries = await readdir(bucketPath, { withFileTypes: true });
      entries = dirEntries.map((entry) => ({ name: entry.name }));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (protectedProjectIds.has(entry.name)) continue;
      const targetPath = path.join(bucketPath, entry.name);
      const info = await safeStat(targetPath);
      if (!info) continue;
      if (info.mtimeMs > cutoffMs) continue;
      await deletePathIfExists(targetPath, log);
    }
  }

  return log;
}

export function summarizeCleanup(log: CleanupLog) {
  return {
    deleted_count: log.deleted.length,
    bytes_reclaimed: log.bytesReclaimed,
    deleted: log.deleted,
    errors: log.errors,
  };
}
