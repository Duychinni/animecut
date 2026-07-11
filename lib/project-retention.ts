export const PROJECT_RETENTION_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getProjectExpiryInfo(completedAt: string | null | undefined, nowMs = Date.now()) {
  if (!completedAt) {
    return { expires_at: null, days_until_expiring: null, is_expired: false };
  }

  const baseMs = new Date(completedAt).getTime();
  if (!Number.isFinite(baseMs)) {
    return { expires_at: null, days_until_expiring: null, is_expired: false };
  }

  const expiresMs = baseMs + PROJECT_RETENTION_DAYS * MS_PER_DAY;
  return {
    expires_at: new Date(expiresMs).toISOString(),
    days_until_expiring: Math.max(0, Math.ceil((expiresMs - nowMs) / MS_PER_DAY)),
    is_expired: expiresMs <= nowMs,
  };
}

