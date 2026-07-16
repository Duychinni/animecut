import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createExportSignedUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const platforms = ['YouTube', 'X', 'Snapchat', 'Instagram', 'TikTok', 'Facebook'] as const;
const gradients = [
  'from-[#252d46] via-[#151928] to-[#09090f]',
  'from-[#3c2030] via-[#1b1622] to-[#09090f]',
  'from-[#43211b] via-[#20141a] to-[#09090f]',
  'from-[#3a1838] via-[#1b1522] to-[#0a0a10]',
  'from-[#40203b] via-[#1c1424] to-[#09090f]',
  'from-[#241d42] via-[#141528] to-[#09090f]',
];

const fallbackClips = [
  ['demo-upload-a', 'Interview clip turned into a clean short', 96, '/demo/upload-demo-a.png'],
  ['demo-results', 'Generated results ready for posting', 94, '/demo/results-demo.png'],
  ['demo-upload-b', 'Long-form upload becomes short-form content', 92, '/demo/upload-demo-b.png'],
  ['demo-processing', 'AI finds moments and packages clips', 91, '/demo/processing-demo.png'],
  ['demo-upload-a-2', 'Strong talking point isolated for reels', 89, '/demo/upload-demo-a.png'],
  ['demo-results-2', 'Multiple shorts organized from one video', 87, '/demo/results-demo.png'],
] as const;

type RelatedCandidate = {
  title?: string | null;
  overall_score?: number | null;
  start_sec?: number | null;
  end_sec?: number | null;
};

type RelatedProject = {
  title?: string | null;
  source_title?: string | null;
  source_channel_name?: string | null;
  source_type?: string | null;
  source_url?: string | null;
  source_video_id?: string | null;
  source_storage_path?: string | null;
};

type ExportShowcaseRow = {
  id: string;
  project_id?: string | null;
  output_storage_path: string | null;
  created_at: string;
  clip_candidates?: RelatedCandidate | RelatedCandidate[] | null;
  projects?: RelatedProject | RelatedProject[] | null;
};

type ShowcaseApiClip = {
  id: string;
  title: string;
  score: number;
  caption: string;
  platform: (typeof platforms)[number];
  length: string;
  source: string;
  gradient: string;
  mediaType: 'video' | 'image' | 'youtube';
  mediaUrl: string;
  posterUrl?: string;
  startSeconds?: number;
  endSeconds?: number;
};

function asSingle<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatClock(totalSeconds: number) {
  const total = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function displayScore(value: number | null | undefined) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 90;
  return Math.max(70, Math.min(100, Math.round(numeric <= 10 ? numeric * 10 : numeric)));
}

function youtubeVideoId(project: RelatedProject | null | undefined) {
  const direct = project?.source_video_id?.trim();
  if (direct) return direct;
  const sourceUrl = project?.source_url?.trim();
  if (!sourceUrl) return null;

  try {
    const url = new URL(sourceUrl);
    if (url.hostname.includes('youtu.be')) return url.pathname.split('/').filter(Boolean)[0] ?? null;
    return url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/?]+)/)?.[1] || null;
  } catch {
    return null;
  }
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
    start: String(Math.max(0, Math.floor(start))),
    end: String(Math.max(Math.floor(start) + 1, Math.ceil(end))),
  });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
}

function getPublicExportIds() {
  return (process.env.SHOWCASE_EXPORT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function getPublicProjectIds() {
  return (process.env.SHOWCASE_PROJECT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function buildFallbackClips(): ShowcaseApiClip[] {
  return fallbackClips.map(([id, title, score, mediaUrl], index) => ({
    id,
    title,
    score,
    caption: '',
    platform: platforms[index % platforms.length],
    length: '0:30',
    source: 'Animacut demo',
    gradient: gradients[index % gradients.length],
    mediaType: 'image' as const,
    mediaUrl,
    posterUrl: mediaUrl,
  }));
}

async function mapRowsToShowcaseClips(rows: ExportShowcaseRow[]): Promise<ShowcaseApiClip[]> {
  const signedClips = await Promise.all(
    rows.map(async (row, index) => {
      if (!row.output_storage_path || row.output_storage_path.startsWith('mock://')) return null;

      try {
        const candidate = asSingle(row.clip_candidates);
        const project = asSingle(row.projects);
        const start = Number(candidate?.start_sec ?? 0);
        const end = Number(candidate?.end_sec ?? 0);
        const length = end > start ? formatClock(end - start) : '0:30';
        const mediaUrl = await createExportSignedUrl(row.output_storage_path, 60 * 60);
        const posterObjectPath = row.output_storage_path.replace(/\.mp4$/i, '.jpg');
        const posterUrl = await createExportSignedUrl(posterObjectPath, 60 * 60).catch(() => undefined);

        return {
          id: row.id,
          title: candidate?.title?.trim() || project?.source_title?.trim() || project?.title?.trim() || 'Generated short',
          score: displayScore(candidate?.overall_score),
          caption: '',
          platform: platforms[index % platforms.length],
          length,
          source: project?.source_channel_name?.trim() || project?.source_title?.trim() || 'Animacut export',
          gradient: gradients[index % gradients.length],
          mediaType: 'video' as const,
          mediaUrl,
          posterUrl,
          startSeconds: start,
          endSeconds: end > start ? end : start + 30,
        };
      } catch {
        return null;
      }
    }),
  );

  const clips: ShowcaseApiClip[] = [];
  for (const clip of signedClips) {
    if (clip) clips.push(clip);
  }

  return clips.slice(0, 6);
}

async function getConfiguredShowcaseClips(exportIds: string[]): Promise<ShowcaseApiClip[]> {
  if (!exportIds.length) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('exports')
    .select(`
      id,
      project_id,
      output_storage_path,
      created_at,
      clip_candidates(title, overall_score, start_sec, end_sec),
      projects(title, source_title, source_channel_name, source_type, source_url, source_video_id, source_storage_path)
    `)
    .eq('status', 'done')
    .not('output_storage_path', 'is', null)
    .in('id', exportIds);

  if (error) throw error;

  const rowsById = new Map(((data ?? []) as ExportShowcaseRow[]).map((row) => [row.id, row]));
  const orderedRows = exportIds.map((id) => rowsById.get(id)).filter((row): row is ExportShowcaseRow => Boolean(row));

  return mapRowsToShowcaseClips(orderedRows);
}

async function getProjectShowcaseClips(projectIds: string[]): Promise<ShowcaseApiClip[]> {
  if (!projectIds.length) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('exports')
    .select(`
      id,
      project_id,
      output_storage_path,
      created_at,
      clip_candidates(title, overall_score, start_sec, end_sec),
      projects(title, source_title, source_channel_name, source_type, source_url, source_video_id, source_storage_path)
    `)
    .eq('status', 'done')
    .not('output_storage_path', 'is', null)
    .in('project_id', projectIds)
    .order('created_at', { ascending: false })
    .limit(120);

  if (error) throw error;

  const rows = ((data ?? []) as ExportShowcaseRow[]).filter((row) => row.project_id);
  const rowsByProject = new Map<string, ExportShowcaseRow>();
  for (const row of rows) {
    const projectId = row.project_id;
    if (projectId && !rowsByProject.has(projectId)) rowsByProject.set(projectId, row);
  }

  const orderedRows = projectIds
    .map((projectId) => rowsByProject.get(projectId))
    .filter((row): row is ExportShowcaseRow => Boolean(row));

  return mapRowsToShowcaseClips(orderedRows);
}

async function getRecentProjectShowcaseClips(): Promise<ShowcaseApiClip[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('exports')
    .select(`
      id,
      project_id,
      output_storage_path,
      created_at,
      clip_candidates(title, overall_score, start_sec, end_sec),
      projects(title, source_title, source_channel_name, source_type, source_url, source_video_id, source_storage_path)
    `)
    .eq('status', 'done')
    .not('output_storage_path', 'is', null)
    .order('created_at', { ascending: false })
    .limit(160);

  if (error) throw error;

  const rowsByProject = new Map<string, ExportShowcaseRow>();
  for (const row of ((data ?? []) as ExportShowcaseRow[])) {
    const projectId = row.project_id;
    if (!projectId || rowsByProject.has(projectId)) continue;
    if (!row.output_storage_path || row.output_storage_path.startsWith('mock://')) continue;
    rowsByProject.set(projectId, row);
    if (rowsByProject.size >= 6) break;
  }

  return mapRowsToShowcaseClips(Array.from(rowsByProject.values()));
}

export async function GET() {
  try {
    const projectClips = await getProjectShowcaseClips(getPublicProjectIds());
    const configuredClips = projectClips.length ? projectClips : await getConfiguredShowcaseClips(getPublicExportIds());
    const recentClips = configuredClips.length ? [] : await getRecentProjectShowcaseClips();
    const clips = configuredClips.length ? configuredClips : recentClips.length ? recentClips : buildFallbackClips();
    return NextResponse.json({ clips }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' } });
  } catch {
    return NextResponse.json({ clips: buildFallbackClips() }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' } });
  }
}
