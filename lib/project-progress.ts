const STAGE_PROGRESS_CEILINGS: Record<string, number> = {
  queued: 1,
  downloading: 4,
  extracting_audio: 6,
  transcribing: 24,
  diarizing: 28,
  finding_hooks: 44,
  creating_clips: 48,
  face_tracking_crop: 52,
  rendering: 97,
  uploading_outputs: 98,
};

export function clampProgressToStage(
  progress: number,
  pipelineStage: string | null | undefined,
  completed = false,
) {
  if (completed) return 100;
  const normalized = Number.isFinite(progress) ? Math.max(0, progress) : 0;
  const ceiling = pipelineStage ? STAGE_PROGRESS_CEILINGS[pipelineStage] : undefined;
  return Math.min(ceiling ?? 98, normalized);
}

export function getPublicPipelineStageLabel(
  pipelineStage: string | null | undefined,
  label: string | null | undefined,
) {
  if (pipelineStage === 'transcribing') return 'Transcribing audio';
  return label || null;
}
