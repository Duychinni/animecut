import { createClient } from '@/lib/supabase/server';
import { PipelineRunner } from '@/components/project/PipelineRunner';
import { TopClipsBoard } from '@/components/clips/TopClipsBoard';
import { createExportSignedUrl } from '@/lib/storage';

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

function targetClipCountForDuration(totalSeconds: number) {
  const minutes = totalSeconds / 60;
  if (minutes <= 5) return 5;
  if (minutes <= 15) return 7;
  if (minutes <= 30) return 10;
  if (minutes <= 60) return 15;
  if (minutes <= 120) return 20;
  return 25;
}

function computeProgress(status: string, doneExports: number, targetCount: number, elapsedSeconds: number) {
  const safeTarget = Math.max(1, targetCount);

  if (status === 'completed') return 100;

  if (status === 'created') {
    const early = Math.min(42, 10 + Math.floor(elapsedSeconds / 4));
    return early;
  }

  if (status === 'transcribed') {
    const mid = Math.min(62, 45 + Math.floor(elapsedSeconds / 6));
    return mid;
  }

  if (status === 'analyzed') {
    return Math.min(99, Math.round(65 + (doneExports / safeTarget) * 35));
  }

  return 5;
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
      .select('title, status, source_type, source_url, source_title, source_thumbnail_url, source_duration_seconds, created_at')
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
      if (row.output_storage_path && !row.output_storage_path.startsWith('/')) {
        try {
          signedUrl = await createExportSignedUrl(row.output_storage_path, 60 * 60);
        } catch {
          signedUrl = null;
        }
      }

      const candidate = row.clip_candidate_id ? candidatesById.get(String(row.clip_candidate_id)) : undefined;

      return {
        ...row,
        signedUrl,
        title: candidate?.title ?? 'Untitled clip',
        score: Number(candidate?.overall_score ?? 0),
        startSec: candidate ? Number(candidate.start_sec) : null,
        endSec: candidate ? Number(candidate.end_sec) : null,
        reason: candidate?.reason ?? null,
        hookStrength: candidate ? Number(candidate.hook_strength) : null,
        rank: candidate?.rank ?? null,
      };
    }),
  );

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
  const targetCount = Math.max(1, targetClipCountForDuration(totalSeconds));
  const doneExports = exportItems.filter((row) => row.status === 'done').length;
  const activeExports = exportItems.filter((row) => row.status === 'queued' || row.status === 'processing').length;
  const failedExports = exportItems.filter((row) => row.status === 'error').length;
  const createdAtMs = projectRow?.created_at ? new Date(projectRow.created_at).getTime() : Date.now();
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - createdAtMs) / 1000));
  const isReallyCompleted =
    activeExports === 0 &&
    (doneExports >= targetCount || doneExports + failedExports >= targetCount || (exportItems.length > 0 && doneExports === exportItems.length));
  const effectiveStatus = isReallyCompleted ? 'completed' : String(projectRow?.status ?? 'created');
  const progressPercent = isReallyCompleted ? 100 : computeProgress(effectiveStatus, doneExports, targetCount, elapsedSeconds);

  let etaSeconds: number | null = null;
  if (effectiveStatus === 'created') etaSeconds = 180;
  else if (effectiveStatus === 'transcribed') etaSeconds = 100;
  else if (effectiveStatus === 'analyzed') etaSeconds = Math.max(0, targetCount - doneExports) * 45;
  else if (effectiveStatus === 'completed') etaSeconds = 0;

  const youtubeId = parseYouTubeId(projectRow?.source_url ?? null);
  const fallbackThumbnail = youtubeId ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` : null;
  const heroThumbnail = projectRow?.source_thumbnail_url || fallbackThumbnail;
  const showProcessingHero = effectiveStatus !== 'completed';

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
          <div className="flex min-h-[68vh] w-full items-start justify-center">
            <div className="w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/10 bg-[#0d0f14] shadow-[0_30px_120px_rgba(0,0,0,0.45)]">
              <div className="grid min-h-[560px] lg:grid-cols-[1.2fr_0.8fr]">
                <div className="relative bg-black">
                  {heroThumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={heroThumbnail} alt={pageTitle} className="h-full w-full object-cover brightness-110" />
                  ) : (
                    <div className="grid h-full min-h-[320px] place-items-center bg-white/5 text-sm text-white/50">Preparing preview...</div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-r from-black/20 via-black/25 to-black/70" />
                </div>

                <div className="flex flex-col justify-center px-8 py-10 lg:px-10">
                  <p className="text-sm uppercase tracking-[0.22em] text-white/45">Processing project</p>
                  <h2 className="mt-4 text-3xl font-semibold leading-tight text-white">{getProcessingLabel(effectiveStatus)}</h2>
                  <p className="mt-3 max-w-md text-sm leading-6 text-white/60">
                    We’re generating clips from this video now. Keep this page open if you want to watch progress, or come back when it’s done.
                  </p>

                  <div className="mt-8 space-y-4">
                    <div>
                      <div className="mb-2 flex items-center justify-between text-sm text-white/70">
                        <span>{progressPercent}% complete</span>
                        <span>ETA {fmtDuration(etaSeconds)}</span>
                      </div>
                      <div className="h-3 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.max(6, Math.min(100, progressPercent))}%` }} />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 pt-2">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                        <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">Target reels created</p>
                        <p className="mt-2 text-2xl font-semibold text-white">{targetCount}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : exportItems.length ? (
          <TopClipsBoard
            projectId={projectId}
            clips={exportItems.map((row) => ({
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
        ) : null}
      </section>
    </main>
  );
}
