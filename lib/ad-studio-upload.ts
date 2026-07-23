const OBS_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv', '.flv'] as const;

export const AD_STUDIO_UPLOAD_ACCEPT = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-flv',
  ...OBS_VIDEO_EXTENSIONS,
].join(',');

export const AD_STUDIO_MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-flv',
]);

export function isAllowedAdStudioUpload(file: Pick<File, 'name' | 'type'>) {
  const name = file.name.toLowerCase();
  const extensionAllowed = OBS_VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension));
  const mime = file.type.toLowerCase().split(';', 1)[0].trim();
  return extensionAllowed && (!mime || mime === 'application/octet-stream' || ALLOWED_MIME_TYPES.has(mime));
}
