const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function isYouTubeHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
}

export function extractYouTubeVideoId(input: string | null | undefined): string | null {
  if (!input) return null;

  try {
    const url = new URL(input.trim());
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    let candidate: string | null = null;

    if (hostname === 'youtu.be') {
      candidate = url.pathname.split('/').filter(Boolean)[0] ?? null;
    } else if (isYouTubeHost(hostname)) {
      if (url.pathname === '/watch') {
        candidate = url.searchParams.get('v');
      } else {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') {
          candidate = parts[1] ?? null;
        }
      }
    }

    if (!candidate) return null;
    const cleanId = candidate.split(/[?&#]/, 1)[0];
    return YOUTUBE_VIDEO_ID.test(cleanId) ? cleanId : null;
  } catch {
    return null;
  }
}

export function isSupportedYouTubeVideoUrl(input: string | null | undefined) {
  return extractYouTubeVideoId(input) !== null;
}

export const YOUTUBE_LINK_ERROR = 'Enter a valid YouTube video link. Other websites are not supported yet; use Upload file for a video saved on your device.';
