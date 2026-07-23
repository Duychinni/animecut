export const MAX_SOURCE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export function sourceUploadSizeError(size: number) {
  return size > MAX_SOURCE_UPLOAD_BYTES
    ? 'This file is over the 5 GB upload limit. Choose a smaller file.'
    : null;
}

export function isUploadLimitError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('upload limit')
    || normalized.includes('free plan')
    || normalized.includes('free upload')
    || normalized.includes('upgrade')
    || normalized.includes('processing minutes remaining')
    || normalized.includes('maximum upload length')
    || normalized.includes('too long for your');
}
