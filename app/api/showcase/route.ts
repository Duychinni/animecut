import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

const platforms = ['YouTube', 'X', 'Snapchat', 'Instagram', 'TikTok', 'Facebook'] as const;
const gradients = [
  'from-[#252d46] via-[#151928] to-[#09090f]',
  'from-[#3c2030] via-[#1b1622] to-[#09090f]',
  'from-[#43211b] via-[#20141a] to-[#09090f]',
  'from-[#3a1838] via-[#1b1522] to-[#0a0a10]',
  'from-[#40203b] via-[#1c1424] to-[#09090f]',
  'from-[#241d42] via-[#141528] to-[#09090f]',
] as const;

type HeroReel = {
  id: string;
  videoId: string;
  start: number;
  end: number;
  title: string;
  source: string;
  score: number;
  mediaUrl?: string;
  posterUrl?: string;
};

// Deliberately hardcoded and manually reviewed frame-by-frame. Keep this list
// at exactly six entries so every visitor sees the same face-led examples.
// Do not replace it with recent exports or a database-driven fallback.
const HERO_REELS: readonly HeroReel[] = [
  {
    id: '6ce069c4-7f50-4ad8-b972-a0870c5bf4bf',
    videoId: 'EonibwnAEME',
    start: 20.46,
    end: 26.46,
    title: "Why You're Capacity Don't Matters",
    source: 'How to Catch Up In Life (Using Logic)',
    score: 86,
    mediaUrl: '/hero-reels/capacity.mp4',
    posterUrl: '/hero-reels/capacity.jpg',
  },
  {
    id: '7096eabc-ae81-4d02-8993-5989cb052fdd',
    videoId: '3A8kawxMOcQ',
    start: 327.84,
    end: 333.84,
    title: 'How MrBeast’s obsession defied odds in a small town',
    source: 'PowerfulJRE',
    score: 93,
    mediaUrl: '/hero-reels/mrbeast.mp4',
    posterUrl: '/hero-reels/mrbeast.jpg',
  },
  {
    id: 'e5ae6592-d592-4d60-91b8-5194f5925c0b',
    videoId: '75gr97-cQ-s',
    start: 358.22,
    end: 364.22,
    title: 'For Explains Creator Will',
    source: 'Arthur Spalanzani',
    score: 89,
    mediaUrl: '/hero-reels/creator.mp4',
    posterUrl: '/hero-reels/creator.jpg',
  },
  {
    id: 'b84e01aa-98cf-4a62-9a7b-8090e1bca775',
    videoId: 'ZWKxukGWF5U',
    start: 85.84,
    end: 91.84,
    title: "Why Audience It's Niche Matters",
    source: 'Aprilynne Alter',
    score: 93,
    mediaUrl: '/hero-reels/audience.mp4',
    posterUrl: '/hero-reels/audience.jpg',
  },
  {
    id: '8832eff5-8e39-4b8d-901f-e88db0b472db',
    videoId: 'sGKXSLmZBz8',
    start: 187.6,
    end: 193.6,
    title: 'What Step Reveals About Intermediate Features',
    source: 'Think Media',
    score: 94,
    mediaUrl: '/hero-reels/intermediate.mp4',
    posterUrl: '/hero-reels/intermediate.jpg',
  },
  {
    id: 'df96d0e8-7b68-4346-80db-3580032934d3',
    videoId: 'gUL6q-FndRE',
    start: 61.82,
    end: 67.82,
    title: 'Why More Over Companies Matters',
    source: 'Starter Story Build',
    score: 93,
    mediaUrl: '/hero-reels/companies.mp4',
    posterUrl: '/hero-reels/companies.jpg',
  },
] as const;

const HERO_REEL_PREVIEW_SECONDS = 5;

function formatClock(totalSeconds: number) {
  const total = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function youtubeShowcaseUrl(videoId: string, start: number, end: number) {
  const params = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    playsinline: '1',
    loop: '1',
    playlist: videoId,
    rel: '0',
    modestbranding: '1',
    cc_load_policy: '0',
    iv_load_policy: '3',
    start: String(start),
    end: String(end),
  });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

function buildHardcodedShowcaseClips() {
  return HERO_REELS.map((reel, index) => {
    const isSelfHosted = Boolean(reel.mediaUrl);
    const previewSeconds = isSelfHosted
      ? Math.min(7, Math.max(5, reel.end - reel.start))
      : HERO_REEL_PREVIEW_SECONDS;

    return {
      id: reel.id,
      title: reel.title,
      score: reel.score,
      caption: '',
      platform: platforms[index],
      length: formatClock(previewSeconds),
      source: reel.source,
      gradient: gradients[index],
      mediaType: isSelfHosted ? 'video' as const : 'youtube' as const,
      mediaUrl: isSelfHosted
        ? reel.mediaUrl!
        : youtubeShowcaseUrl(reel.videoId, reel.start, reel.start + previewSeconds),
      posterUrl: reel.posterUrl
        ? reel.posterUrl
        : `https://i.ytimg.com/vi/${encodeURIComponent(reel.videoId)}/hqdefault.jpg`,
      // Self-hosted assets are already trimmed, so starting them at their
      // original YouTube timestamp would jump to the final frame before loop.
      startSeconds: isSelfHosted ? 0 : reel.start,
      endSeconds: isSelfHosted ? previewSeconds : reel.start + previewSeconds,
    };
  });
}

export async function GET() {
  return NextResponse.json(
    { clips: buildHardcodedShowcaseClips() },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' } },
  );
}
