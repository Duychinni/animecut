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

function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.split('/').filter(Boolean)[0] ?? null;
    }
    if (u.hostname.includes('youtube.com')) {
      return u.searchParams.get('v');
    }
    return null;
  } catch {
    return null;
  }
}

function parseIso8601Duration(input: string): number | null {
  const match = input.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const mins = Number(match[2] ?? 0);
  const secs = Number(match[3] ?? 0);
  return hours * 3600 + mins * 60 + secs;
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
