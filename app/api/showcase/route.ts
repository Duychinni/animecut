import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createExportSignedUrl } from '@/lib/storage';

const platforms = ['YouTube', 'X', 'Snapchat', 'Instagram', 'TikTok', 'Facebook'] as const;
const gradients = [
  'from-[#252d46] via-[#151928] to-[#09090f]',
  'from-[#3c2030] via-[#1b1622] to-[#09090f]',
  'from-[#43211b] via-[#20141a] to-[#09090f]',
  'from-[#3a1838] via-[#1b1522] to-[#0a0a10]',
  'from-[#40203b] via-[#1c1424] to-[#09090f]',
  'from-[#241d42] via-[#141528] to-[#09090f]',
];

type ExportShowcaseRow = {
  id: string;
  output_storage_path: string | null;
  created_at: string;
  clip_candidates?: {
    title?: string | null;
    overall_score?: number | null;
    start_sec?: number | null;
    end_sec?: number | null;
  } | null;
  projects?: {
    title?: string | null;
    source_title?: string | null;
    source_channel_name?: string | null;
  } | null;
};

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

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;

    if (!user) {
      return NextResponse.json({ clips: [] });
    }

    const { data, error } = await supabase
      .from('exports')
      .select(`
        id,
        output_storage_path,
        created_at,
        clip_candidates(title, overall_score, start_sec, end_sec),
        projects(title, source_title, source_channel_name)
      `)
      .eq('status', 'done')
      .not('output_storage_path', 'is', null)
      .order('created_at', { ascending: false })
      .limit(12);

    if (error) throw error;

    const signedClips = await Promise.all(
      ((data ?? []) as ExportShowcaseRow[]).map(async (row, index) => {
        if (!row.output_storage_path || row.output_storage_path.startsWith('mock://')) return null;

        try {
          const mediaUrl = await createExportSignedUrl(row.output_storage_path, 60 * 60);
          const start = Number(row.clip_candidates?.start_sec ?? 0);
          const end = Number(row.clip_candidates?.end_sec ?? 0);
          const length = end > start ? formatClock(end - start) : '0:30';

          return {
            id: row.id,
            title: row.clip_candidates?.title?.trim() || row.projects?.source_title?.trim() || row.projects?.title?.trim() || 'Generated short',
            score: displayScore(row.clip_candidates?.overall_score),
            caption: 'Generated from your saved Animacut exports.',
            platform: platforms[index % platforms.length],
            length,
            source: row.projects?.source_channel_name?.trim() || row.projects?.source_title?.trim() || 'Animacut export',
            gradient: gradients[index % gradients.length],
            mediaUrl,
          };
        } catch {
          return null;
        }
      }),
    );

    return NextResponse.json({ clips: signedClips.filter(Boolean).slice(0, 6) });
  } catch {
    return NextResponse.json({ clips: [] });
  }
}
