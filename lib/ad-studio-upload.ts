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
export const AD_ASSET_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export function isAllowedAdStudioUpload(file: Pick<File, 'name' | 'type'>) {
  const name = file.name.toLowerCase();
  // Browsers do not agree on OBS container MIME types. In particular, Windows
  // may report MKV as application/x-matroska, video/mkv, octet-stream, or even
  // text/plain. The selected extension is reliable here and FFmpeg performs the
  // real media preflight before rendering.
  return OBS_VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension));
}
