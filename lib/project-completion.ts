type SettledExportCompletionInput = {
  totalExports: number;
  doneExports: number;
  failedExports: number;
  activeExports: number;
  activeJobs: number;
};

export function hasSettledPlayableExports(input: SettledExportCompletionInput) {
  const { totalExports, doneExports, failedExports, activeExports, activeJobs } = input;

  // Unsafe candidates intentionally fail closed. Once every attempt is
  // terminal, those rejected exports must not leave a project looking active
  // forever when at least one safe reel is already playable.
  return totalExports > 0
    && doneExports > 0
    && activeExports === 0
    && activeJobs === 0
    && doneExports + failedExports >= totalExports;
}

/** @deprecated Use hasSettledPlayableExports. */
export const hasSettledSuccessfulExports = hasSettledPlayableExports;
