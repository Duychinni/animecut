export const MAX_SOURCE_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const SOURCE_UPLOAD_LIMIT_LABEL =
  'Up to 5 GB · 20 min Free · 1 hr Starter · 2 hr Creator · 3 hr Pro';

export function sourceUploadSizeError(size: number) {
  return size > MAX_SOURCE_UPLOAD_BYTES
    ? 'This file is over the 5 GB upload limit. Choose a smaller file.'
    : null;
}
