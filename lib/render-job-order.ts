export type RenderWorkItem = {
  projectId: string;
  payload: Record<string, unknown>;
};

function isPreview(item: RenderWorkItem) {
  return item.payload.preview_only === true;
}

function estimatedDuration(item: RenderWorkItem) {
  const duration = Number(item.payload.render_duration_seconds ?? 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function editorialPriority(item: RenderWorkItem) {
  const priority = Number(item.payload.editorial_priority ?? Number.MAX_SAFE_INTEGER);
  return Number.isFinite(priority) && priority >= 0 ? priority : Number.MAX_SAFE_INTEGER;
}

const PRIORITY_REEL_WAVE_SIZE = 6;

export function prioritizeMainRenderJobs<T extends RenderWorkItem>(items: T[]) {
  return [...items].sort((left, right) => {
    const previewDifference = Number(isPreview(left)) - Number(isPreview(right));
    if (previewDifference) return previewDifference;

    // Preserve plan/project ordering established by the caller. Within one
    // project, finish its strongest six reels before starting the remainder so
    // the creator receives a useful top set quickly. Balance duration inside
    // each wave to avoid one long encode becoming the final straggler.
    if (!isPreview(left) && left.projectId === right.projectId) {
      const leftPriority = editorialPriority(left);
      const rightPriority = editorialPriority(right);
      const leftWave = leftPriority < PRIORITY_REEL_WAVE_SIZE ? 0 : 1;
      const rightWave = rightPriority < PRIORITY_REEL_WAVE_SIZE ? 0 : 1;
      if (leftWave !== rightWave) return leftWave - rightWave;

      // Within the first wave, keep the very best three at the front so the
      // three Mac mini workers claim them on their first pass.
      if (leftWave === 0) {
        const leftBatch = Math.floor(leftPriority / 3);
        const rightBatch = Math.floor(rightPriority / 3);
        if (leftBatch !== rightBatch) return leftBatch - rightBatch;
      }

      return estimatedDuration(right) - estimatedDuration(left);
    }

    return 0;
  });
}
