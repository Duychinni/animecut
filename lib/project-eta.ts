export type RenderEtaRow = {
  created_at?: string | null;
};

export function estimateObservedRenderEtaSeconds(params: {
  pipelineStatus: string | null;
  pipelineStage: string | null;
  readyExports: number;
  exportCount: number;
  exportRows: RenderEtaRow[];
  nowMs?: number;
}) {
  const {
    pipelineStatus,
    pipelineStage,
    readyExports,
    exportCount,
    exportRows,
    nowMs = Date.now(),
  } = params;

  if (pipelineStatus !== 'processing' || pipelineStage !== 'rendering') return null;
  if (exportCount <= 0 || readyExports < 2 || readyExports >= exportCount) return null;

  const queueStartedAt = exportRows.reduce<number | null>((earliest, row) => {
    const value = Date.parse(String(row.created_at || ''));
    if (!Number.isFinite(value)) return earliest;
    return earliest === null ? value : Math.min(earliest, value);
  }, null);
  if (queueStartedAt === null) return null;

  const elapsedSeconds = Math.max(0, (nowMs - queueStartedAt) / 1000);
  // Avoid extrapolating from a brief startup burst. Measured project
  // throughput includes real render complexity, uploads, and worker contention.
  if (elapsedSeconds < 60) return null;

  const secondsPerCompletedExport = elapsedSeconds / readyExports;
  const remainingExports = exportCount - readyExports;
  // Use a conservative margin because later clips can be longer or more
  // expensive to reframe than the first completed batch.
  const conservativeSeconds = secondsPerCompletedExport * remainingExports * 1.2;
  return Math.max(30, Math.ceil(conservativeSeconds / 30) * 30);
}
