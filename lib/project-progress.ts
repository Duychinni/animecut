const STAGE_PROGRESS_CEILINGS: Record<string, number> = {
  queued: 8,
  downloading: 14,
  extracting_audio: 24,
  transcribing: 44,
  diarizing: 50,
  finding_hooks: 60,
  creating_clips: 70,
  face_tracking_crop: 78,
  rendering: 96,
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
