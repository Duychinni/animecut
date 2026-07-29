import { getRequiredClipCount } from '@/lib/clip-policy';

export type RenderEtaRow = {
  created_at?: string | null;
};

const STAGE_ORDER = [
  'queued',
  'downloading',
  'extracting_audio',
  'transcribing',
  'diarizing',
  'finding_hooks',
  'creating_clips',
  'face_tracking_crop',
  'rendering',
  'uploading_outputs',
] as const;

function roundEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 30;
  const interval = seconds >= 10 * 60 ? 60 : 30;
  return Math.max(30, Math.ceil(seconds / interval) * interval);
}

function expectedStageSeconds(sourceDurationSeconds: number, exportCount: number) {
  const sourceMinutes = Math.max(0.5, sourceDurationSeconds / 60);
  const estimatedExports = Math.max(1, exportCount || getRequiredClipCount(sourceDurationSeconds));
  return {
    queued: 15,
    downloading: Math.max(25, sourceMinutes * 1.4),
    extracting_audio: Math.max(12, sourceMinutes * 0.45),
    transcribing: Math.max(50, sourceMinutes * 7.2),
    diarizing: Math.max(20, sourceMinutes * 1.2),
    finding_hooks: Math.max(55, Math.min(210, sourceMinutes * 5.0)),
    creating_clips: 25,
    face_tracking_crop: 20,
    // Three production workers render concurrently. This includes semantic
    // framing, 1080p encode, preview generation, and large-media upload.
    rendering: Math.max(90, Math.ceil(estimatedExports / 3) * 82),
    uploading_outputs: 20,
  };
}

export function estimateObservedRenderEtaSeconds(params: {
  pipelineStatus: string | null;
  pipelineStage: string | null;
  readyExports: number;
  exportCount: number;
  exportRows: RenderEtaRow[];
  sourceDurationSeconds?: number | null;
  elapsedSeconds?: number;
  nowMs?: number;
}) {
  const {
    pipelineStatus,
    pipelineStage,
    readyExports,
    exportCount,
    exportRows,
    sourceDurationSeconds = 0,
    elapsedSeconds = 0,
    nowMs = Date.now(),
  } = params;

  if (!['queued', 'processing'].includes(String(pipelineStatus))) return null;

  const stage = String(pipelineStage || 'queued');
  const stageIndex = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  const expected = expectedStageSeconds(Number(sourceDurationSeconds || 0), exportCount);
  const safeStageIndex = stageIndex >= 0 ? stageIndex : 0;

  if (stage !== 'rendering') {
    const previousExpected = STAGE_ORDER
      .slice(0, safeStageIndex)
      .reduce((sum, key) => sum + expected[key], 0);
    const currentElapsed = Math.max(0, elapsedSeconds - previousExpected);
    const currentRemaining = Math.max(expected[STAGE_ORDER[safeStageIndex]] * 0.15, expected[STAGE_ORDER[safeStageIndex]] - currentElapsed);
    const downstream = STAGE_ORDER
      .slice(safeStageIndex + 1)
      .reduce((sum, key) => sum + expected[key], 0);
    return roundEta(currentRemaining + downstream);
  }

  if (exportCount <= 0) return roundEta(expected.rendering + expected.uploading_outputs);
  if (readyExports >= exportCount) return roundEta(expected.uploading_outputs);

  const queueStartedAt = exportRows.reduce<number | null>((earliest, row) => {
    const value = Date.parse(String(row.created_at || ''));
    if (!Number.isFinite(value)) return earliest;
    return earliest === null ? value : Math.min(earliest, value);
  }, null);
  if (queueStartedAt === null) return roundEta(expected.rendering + expected.uploading_outputs);

  const renderElapsedSeconds = Math.max(0, (nowMs - queueStartedAt) / 1000);
  const remainingExports = exportCount - readyExports;

  if (readyExports < 1 || renderElapsedSeconds < 30) {
    const batchesRemaining = Math.ceil(remainingExports / 3);
    return roundEta(batchesRemaining * 82 + expected.uploading_outputs);
  }

  // Measured project throughput automatically accounts for real clip length,
  // framing complexity, worker contention, encoding, and upload speed.
  const observedThroughputEta = (renderElapsedSeconds / readyExports) * remainingExports;
  const baselineEta = Math.ceil(remainingExports / 3) * 82;
  return roundEta(Math.max(baselineEta * 0.65, observedThroughputEta * 1.1) + expected.uploading_outputs);
}
