import { extractYouTubeVideoId } from '@/lib/youtube-url';

type SourceMetadata = {
  sourceUrl: string | null;
  sourcePlatform: 'youtube' | 'upload' | null;
  sourceVideoId: string | null;
  sourceTitle: string | null;
  sourceThumbnailUrl: string | null;
  sourceChannelName: string | null;
  sourceDurationSeconds: number | null;
};

export function stableYouTubeThumbnail(url: string | null | undefined, videoId: string | null) {
  if (typeof url === 'string' && url.trim()) {
    return url.trim().replace(/\/maxresdefault\.jpg(?:\?.*)?$/i, '/hqdefault.jpg');
  }

  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function parseIso8601Duration(input: string): number | null {
  const match = input.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const mins = Number(match[2] ?? 0);
  const secs = Number(match[3] ?? 0);
  return hours * 3600 + mins * 60 + secs;
}

function parseYouTubeDurationFromHtml(html: string): number | null {
  const lengthSeconds = html.match(/"lengthSeconds"\s*:\s*"?(\d+)"?/i)?.[1];
  if (lengthSeconds) {
    const seconds = Number(lengthSeconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }

  const approxDurationMs = html.match(/"approxDurationMs"\s*:\s*"?(\d+)"?/i)?.[1];
  if (approxDurationMs) {
    const seconds = Math.round(Number(approxDurationMs) / 1000);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }

  const isoDuration = html.match(/(?:itemprop=["']duration["'][^>]*content=|"duration"\s*:\s*)["'](PT[^"']+)["']/i)?.[1];
  return isoDuration ? parseIso8601Duration(isoDuration) : null;
}

async function fetchYouTubeWatchPageDuration(videoId: string): Promise<number | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
      cache: 'no-store',
      headers: {
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (compatible; AnimaCut/1.0; +https://animacut.app)',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return parseYouTubeDurationFromHtml(await res.text());
  } catch {
    return null;
  }
}

export async function fetchYouTubeSourceMetadata(url: string): Promise<SourceMetadata> {
  const videoId = extractYouTubeVideoId(url);
  const base: SourceMetadata = {
    sourceUrl: url,
    sourcePlatform: 'youtube',
    sourceVideoId: videoId,
    sourceTitle: null,
    sourceThumbnailUrl: null,
    sourceChannelName: null,
    sourceDurationSeconds: null,
  };

  if (!videoId) return base;

  try {
    const oembedUrl = new URL('https://www.youtube.com/oembed');
    oembedUrl.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`);
    oembedUrl.searchParams.set('format', 'json');
    const res = await fetch(oembedUrl.toString(), { cache: 'no-store' });
    if (res.ok) {
      const data = (await res.json()) as { title?: string; thumbnail_url?: string; author_name?: string };
      base.sourceTitle = data.title ?? null;
      base.sourceThumbnailUrl = stableYouTubeThumbnail(data.thumbnail_url ?? null, videoId);
      base.sourceChannelName = data.author_name ?? null;
    }
  } catch {}

  const apiKey = process.env.YOUTUBE_DATA_API_KEY;
  if (apiKey) {
    try {
      const apiUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
      apiUrl.searchParams.set('id', videoId);
      apiUrl.searchParams.set('part', 'snippet,contentDetails');
      apiUrl.searchParams.set('key', apiKey);
      const res = await fetch(apiUrl.toString(), { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as {
          items?: Array<{
            snippet?: { title?: string; channelTitle?: string; thumbnails?: { high?: { url?: string }; maxres?: { url?: string } } };
            contentDetails?: { duration?: string };
          }>;
        };
        const item = data.items?.[0];
        if (item?.snippet?.title) base.sourceTitle = item.snippet.title;
        if (item?.snippet?.channelTitle) base.sourceChannelName = item.snippet.channelTitle;
        const apiThumbnailUrl =
          item?.snippet?.thumbnails?.maxres?.url ??
          item?.snippet?.thumbnails?.high?.url ??
          base.sourceThumbnailUrl;
        base.sourceThumbnailUrl = stableYouTubeThumbnail(apiThumbnailUrl, videoId);
        if (item?.contentDetails?.duration) {
          base.sourceDurationSeconds = parseIso8601Duration(item.contentDetails.duration);
        }
      }
    } catch {}
  }

  // oEmbed has no duration, and serverless deployments generally do not have
  // yt-dlp installed. The watch page contains the same player duration and is
  // a safe fallback when the optional YouTube Data API key is not configured.
  if (!base.sourceDurationSeconds) {
    base.sourceDurationSeconds = await fetchYouTubeWatchPageDuration(videoId);
  }

  return base;
}

export function makeUploadSourceMetadata(fileName: string | null): SourceMetadata {
  return {
    sourceUrl: null,
    sourcePlatform: 'upload',
    sourceVideoId: null,
    sourceTitle: fileName,
    sourceThumbnailUrl: null,
    sourceChannelName: null,
    sourceDurationSeconds: null,
  };
}
