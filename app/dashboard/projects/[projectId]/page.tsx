import { createClient } from '@/lib/supabase/server';
import { PipelineRunner } from '@/components/project/PipelineRunner';
import { ProcessingHero } from '@/components/project/ProcessingHero';
import { TopClipsBoard } from '@/components/clips/TopClipsBoard';
import { createExportSignedUrl } from '@/lib/storage';
import { getTargetClipCount } from '@/lib/clip-policy';

type ExportRow = {
  id: string;
  clip_candidate_id: string | null;
  status: string;
  output_storage_path: string | null;
  error_message: string | null;
  created_at: string;
};

type CandidateRow = {
  id: string;
  title: string;
  overall_score: number;
  start_sec: number;
  end_sec: number;
  reason: string;
  hook_strength: number;
  rank: number | null;
};

function fmtDuration(totalSec: number | null | undefined) {
  if (typeof totalSec !== 'number' || !Number.isFinite(totalSec)) return '—';
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

function parseYouTubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.replace('/', '') || null;
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch {
    return null;
  }
}

function getProcessingLabel(status: string) {
  if (status === 'created') return 'Fetching video and preparing transcript';
  if (status === 'transcribed') return 'Transcript ready — finding the best moments';
  if (status === 'analyzed') return 'Rendering clips and packaging exports';
  if (status === 'completed') return 'Completed';
  return 'Processing your video';
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ autorun?: string }>;
}) {
  const { projectId } = await params;
  const { autorun } = await searchParams;
  const autoStart = autorun === '1' || autorun === 'true';
  const supabase = await createClient();

  const [{ data: projectRow }, { data: exportsRows }, { data: candidateRows }, { data: transcriptRow }] = await Promise.all([
    supabase
      .from('projects')
      .select('title, status, pipeline_status, pipeline_error, pipeline_progress_percent, source_type, source_url, source_title, source_thumbnail_url, source_duration_seconds, created_at')
      .eq('id', projectId)
      .single(),
    supabase
      .from('exports')
      .select('id, clip_candidate_id, status, output_storage_path, error_message, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('clip_candidates')
      .select('id, title, overall_score, start_sec, end_sec, reason, hook_strength, rank')
      .eq('project_id', projectId)
      .limit(50),
    supabase
      .from('transcripts')
      .select('segments_json')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
  ]);

  const candidatesById = new Map<string, CandidateRow>(((candidateRows ?? []) as CandidateRow[]).map((c) => [String(c.id), c]));

  const exportItems = await Promise.all(
    ((exportsRows ?? []) as ExportRow[]).map(async (row) => {
      let signedUrl: string | null = null;
      const isMockExport = Boolean(row.output_storage_path?.startsWith('mock://'));
      if (row.output_storage_path && !row.output_storage_path.startsWith('/') && !isMockExport) {
        try {
          signedUrl = await createExportSignedUrl(row.output_storage_path, 60 * 60);
        } catch {
          signedUrl = null;
        }
      }

      const candidate = row.clip_candidate_id ? candidatesById.get(String(row.clip_candidate_id)) : undefined;

      const startSec = candidate ? Number(candidate.start_sec) : null;
      const endSec = candidate ? Number(candidate.end_sec) : null;
      const derivedDuration = startSec != null && endSec != null ? Math.max(0, endSec - startSec) : 0;
      const durationSeconds = Number(derivedDuration ?? 0);
      const rawScore = Number(candidate?.overall_score ?? 0);
      const score = Math.max(70, Math.min(100, Math.round(rawScore <= 10 ? rawScore * 10 : rawScore)));

      return {
        ...row,
        signedUrl,
        title: candidate?.title ?? 'Untitled clip',
        score,
        startSec,
        endSec,
        durationSeconds,
        reason: candidate?.reason ?? null,
        hookStrength: candidate ? Number(candidate.hook_strength) : null,
        rank: candidate?.rank ?? null,
      };
    }),
  );

  const filteredExportItems = exportItems
    .filter((row, index, arr) => {
      const title = String(row.title ?? '').trim().toLowerCase();
      const duration = Number(row.durationSeconds ?? 0);
      return arr.findIndex((other) => {
        const otherTitle = String(other.title ?? '').trim().toLowerCase();
        const otherDuration = Number(other.durationSeconds ?? 0);
        const similarTitle = title && otherTitle && (title === otherTitle || title.slice(0, 36) === otherTitle.slice(0, 36));
        const similarWindow = row.startSec != null && row.endSec != null && other.startSec != null && other.endSec != null
          ? Math.abs(row.startSec - other.startSec) < 3 && Math.abs(row.endSec - other.endSec) < 3
          : false;
        const similarDuration = Math.abs(duration - otherDuration) < 3;
        return similarTitle || (similarWindow && similarDuration);
      }) === index;
    });

  const pageTitle =
    typeof projectRow?.source_title === 'string' && projectRow.source_title.trim().length
      ? projectRow.source_title.trim()
      : typeof projectRow?.title === 'string' && projectRow.title.trim().length
        ? projectRow.title.trim()
        : 'Untitled video';

  const transcriptSegments = Array.isArray(transcriptRow?.segments_json) ? (transcriptRow?.segments_json as { end?: number }[]) : [];
  const transcriptSeconds = transcriptSegments.reduce((acc, s) => Math.max(acc, Number(s?.end ?? 0)), 0);
  const sourceDurationSeconds = Number(projectRow?.source_duration_seconds ?? 0);
  const totalSeconds = transcriptSeconds > 0 ? transcriptSeconds : sourceDurationSeconds;
  const targetCount = Math.max(1, getTargetClipCount(totalSeconds));
  const doneExports = filteredExportItems.filter((row) => row.status === 'done').length;
  const activeExports = filteredExportItems.filter((row) => row.status === 'queued' || row.status === 'processing').length;
  const rawProgressPercent = Number(projectRow?.pipeline_progress_percent ?? 0);
  const pipelineStatus = String(projectRow?.pipeline_status ?? 'idle');
  const isCompletedFromRows = doneExports > 0 && activeExports === 0 && doneExports >= Math.min(targetCount, filteredExportItems.length || targetCount);
  const effectiveStatus = isCompletedFromRows ? 'completed' : String(projectRow?.status ?? 'created');
  const progressPercent = effectiveStatus === 'completed' || pipelineStatus === 'completed'
    ? 100
    : Math.max(0, Math.min(99, Number.isFinite(rawProgressPercent) ? rawProgressPercent : 0));

  const youtubeId = parseYouTubeId(projectRow?.source_url ?? null);
  const fallbackThumbnail = youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg` : null;
  const heroThumbnail = projectRow?.source_thumbnail_url || fallbackThumbnail;
  const doneResultItems = filteredExportItems.filter((row) => row.status === 'done');
  const hasRenderableResults = doneResultItems.some((row) => Boolean(row.signedUrl));
  const hasMockResults = doneResultItems.some((row) => row.output_storage_path?.startsWith('mock://'));
  const hasExportRows = filteredExportItems.length > 0;
  const hasActiveExports = activeExports > 0 || filteredExportItems.some((row) => row.status === 'queued' || row.status === 'processing');
  const shouldShowCompletedState = !hasExportRows && !hasActiveExports && (effectiveStatus === 'completed' || pipelineStatus === 'completed' || progressPercent >= 100);
  const showProcessingHero = !hasExportRows && !hasRenderableResults && !hasMockResults && !shouldShowCompletedState;

  return (
    <main className="mx-auto w-full max-w-[2400px] px-8 py-10">
      <section className="flex flex-col items-center">
        <div className="mb-8 w-full max-w-5xl text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">{pageTitle}</h1>
        </div>

        <div className="sr-only">
          <PipelineRunner projectId={projectId} autoStart={autoStart} />
        </div>

        {showProcessingHero ? (
          <ProcessingHero
            projectId={projectId}
            pageTitle={pageTitle}
            heroThumbnail={heroThumbnail}
            fallbackPercent={progressPercent}
            fallbackTargetCount={targetCount}
          />
        ) : hasExportRows ? (
          <TopClipsBoard
            projectId={projectId}
            clips={filteredExportItems.map((row) => ({
              exportId: row.id,
              clipCandidateId: row.clip_candidate_id,
              title: row.title,
              score: row.score,
              status: row.status,
              errorMessage: row.error_message,
              signedUrl: row.signedUrl,
              startSec: row.startSec,
              endSec: row.endSec,
              rank: row.rank,
            }))}
          />
        ) : shouldShowCompletedState ? (
          <div className="w-full max-w-3xl rounded-3xl border border-white/10 bg-white/[0.03] px-8 py-12 text-center">
            <h2 className="text-2xl font-semibold text-white">Processing finished</h2>
            <p className="mt-3 text-sm text-white/60">The backend marked this project complete, but no playable reels were available in this page load yet. Refresh once and the reels should appear.</p>
          </div>
        ) : null}
      </section>
    </main>
  );
}
