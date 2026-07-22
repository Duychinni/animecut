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

// Deliberately hardcoded and manually reviewed frame-by-frame. Keep this list
// at exactly six entries so every visitor sees the same face-led examples.
// Do not replace it with recent exports or a database-driven fallback.
const HERO_REELS = [
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
  { id: '1a67397f-8b68-4cc0-a0bd-01a52ce6083d', videoId: '_KaFS4Dxs5k', start: 249, end: 292, title: 'A founder shares the opportunities he is building', source: 'Starter Story', score: 94 },
  { id: '5a4dd977-6401-4cc9-9535-b51c425daf49', videoId: '_KaFS4Dxs5k', start: 139, end: 175, title: 'A founder breaks down his product approach', source: 'Starter Story', score: 93 },
  { id: '220a19a9-8bbe-4dac-823d-7877a234032e', videoId: '_KaFS4Dxs5k', start: 80, end: 111, title: 'A founder explains the tools behind his product', source: 'Starter Story', score: 92 },
  { id: '1fff2e2c-7171-4d2f-a47f-fa04472c54ce', videoId: 'w3zxMrwWrt0', start: 174, end: 211, title: 'A founder explains his daily side-project routine', source: 'Starter Story', score: 91 },
  { id: '54a6609e-2ac7-426c-9fe5-6e7058781fba', videoId: 'w3zxMrwWrt0', start: 82, end: 112, title: 'A founder explains how his product works', source: 'Starter Story', score: 90 },
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
  return HERO_REELS.map((reel, index) => ({
    id: reel.id,
    title: reel.title,
    score: reel.score,
    caption: '',
    platform: platforms[index],
    length: formatClock(HERO_REEL_PREVIEW_SECONDS),
    source: reel.source,
    gradient: gradients[index],
    mediaType: 'mediaUrl' in reel ? 'video' as const : 'youtube' as const,
    mediaUrl: 'mediaUrl' in reel
      ? reel.mediaUrl
      : youtubeShowcaseUrl(reel.videoId, reel.start, reel.start + HERO_REEL_PREVIEW_SECONDS),
    posterUrl: 'posterUrl' in reel
      ? reel.posterUrl
      : `https://i.ytimg.com/vi/${encodeURIComponent(reel.videoId)}/hqdefault.jpg`,
    startSeconds: reel.start,
    endSeconds: reel.start + HERO_REEL_PREVIEW_SECONDS,
  }));
}

export async function GET() {
  return NextResponse.json(
    { clips: buildHardcodedShowcaseClips() },
    { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' } },
  );
}
