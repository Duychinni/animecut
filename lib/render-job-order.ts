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

export function prioritizeMainRenderJobs<T extends RenderWorkItem>(items: T[]) {
  return [...items].sort((left, right) => {
    const previewDifference = Number(isPreview(left)) - Number(isPreview(right));
    if (previewDifference) return previewDifference;

    // Preserve plan/project ordering established by the caller. Within one
    // project's main-render batch, starting long reels first minimizes the
    // chance that one long encode runs alone after the other workers go idle.
    if (!isPreview(left) && left.projectId === right.projectId) {
      return estimatedDuration(right) - estimatedDuration(left);
    }

    return 0;
  });
}
