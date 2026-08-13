function configuredDeadlineMs(raw: unknown) {
  const seconds = Number(raw ?? 0);
  const resolvedSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 20 * 60;
  return Math.max(5 * 60, Math.min(45 * 60, resolvedSeconds)) * 1000;
}

export function renderJobDeadlineMs() {
  return configuredDeadlineMs(process.env.EXPORT_JOB_TIMEOUT_SECONDS);
}

export async function runWithRenderJobDeadline<T>(
  operation: Promise<T>,
  context: { exportId: string; timeoutMs?: number },
) {
  const timeoutMs = context.timeoutMs ?? renderJobDeadlineMs();
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `render job timed out after ${Math.round(timeoutMs / 1000)}s before completion (export ${context.exportId})`,
          ));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
