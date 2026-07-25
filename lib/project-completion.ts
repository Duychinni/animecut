type SettledExportCompletionInput = {
  totalExports: number;
  doneExports: number;
  failedExports: number;
  activeExports: number;
  activeJobs: number;
  requiredPlayableExports?: number;
};

export function hasSettledPlayableExports(input: SettledExportCompletionInput) {
  const { totalExports, doneExports, failedExports, activeExports, activeJobs } = input;
  const requiredPlayableExports = Math.max(1, Math.min(
    totalExports,
    Math.floor(input.requiredPlayableExports ?? 1),
  ));

  // Terminal failures may coexist with a healthy result, but one lucky render
  // must never make a long-form project appear successfully completed after
  // the rest of its expected reels failed.
  return totalExports > 0
    && doneExports >= requiredPlayableExports
    && activeExports === 0
    && activeJobs === 0
    && doneExports + failedExports >= totalExports;
}

/** @deprecated Use hasSettledPlayableExports. */
export const hasSettledSuccessfulExports = hasSettledPlayableExports;
