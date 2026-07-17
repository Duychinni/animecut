type SettledExportCompletionInput = {
  totalExports: number;
  doneExports: number;
  failedExports: number;
  activeExports: number;
  activeJobs: number;
};

export function hasSettledSuccessfulExports(input: SettledExportCompletionInput) {
  const { totalExports, doneExports, failedExports, activeExports, activeJobs } = input;

  return totalExports > 0
    && doneExports > 0
    && failedExports === 0
    && activeExports === 0
    && activeJobs === 0
    && doneExports + failedExports >= totalExports;
}
