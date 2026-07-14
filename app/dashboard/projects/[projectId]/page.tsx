import { createClient } from '@/lib/supabase/server';
import { PipelineRunner } from '@/components/project/PipelineRunner';
import { ProcessingHero } from '@/components/project/ProcessingHero';
import { TopClipsBoard } from '@/components/clips/TopClipsBoard';
import { createExportSignedUrl } from '@/lib/storage';
import { getTargetClipCount } from '@/lib/clip-policy';
import { ensureProjectUploadThumbnail } from '@/lib/upload-thumbnail';
import { stableYouTubeThumbnail } from '@/lib/source-metadata';
import { PROJECT_RETENTION_DAYS, getProjectExpiryInfo } from '@/lib/project-retention';

type ExportRow = {
  id: string;
  clip_candidate_id: string | null;
  status: string;
  output_storage_path: string | null;
  error_message: string | null;
  created_at: string;
  updated_at?: string | null;
  caption_preset_id: string | null;
  clip_edit_settings?: {
    clip_start_seconds?: number;
    clip_end_seconds?: number;
    captions_enabled?: boolean;
    caption_highlight_color?: string;
  } | null;
  edit_status?: string | null;
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

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

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

function getExportPosterPath(outputPath: string | null) {
  if (!outputPath || outputPath.startsWith('/') || outputPath.startsWith('mock://')) return null;
  if (!/\.mp4$/i.test(outputPath)) return null;
  return outputPath.replace(/\.mp4$/i, '.jpg');
}

function hasSavedPlayableOutput(row: { status?: string | null; output_storage_path?: string | null; signedUrl?: string | null }) {
  return row.status !== 'error'
    && Boolean(row.signedUrl)
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://');
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return [
      record.message,
      record.details,
      record.hint,
      record.code,
      JSON.stringify(record),
    ].filter(Boolean).join(' ');
  }
  return String(error);
}

function isMissingEditColumnError(error: unknown) {
  const text = errorText(error);
  return /(clip_edit_settings|edit_status)/i.test(text)
    && /(column|schema cache|could not find|PGRST204|42703)/i.test(text);
}

async function loadProjectExports(supabase: SupabaseServerClient, projectId: string): Promise<ExportRow[]> {
  const withEditFields = await supabase
    .from('exports')
    .select('id, clip_candidate_id, status, output_storage_path, error_message, created_at, updated_at, caption_preset_id, clip_edit_settings, edit_status')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (!withEditFields.error) return (withEditFields.data ?? []) as ExportRow[];
  if (!isMissingEditColumnError(withEditFields.error)) throw withEditFields.error;

  console.warn('[project/detail] edit columns missing; loading exports with legacy schema', { project_id: projectId });
  const legacyExports = await supabase
    .from('exports')
    .select('id, clip_candidate_id, status, output_storage_path, error_message, created_at, updated_at, caption_preset_id')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (legacyExports.error) throw legacyExports.error;
  return ((legacyExports.data ?? []) as ExportRow[]).map((row) => ({
    ...row,
    clip_edit_settings: null,
    edit_status: null,
  }));
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

  const [projectResult, exportsRows, candidateResult, transcriptResult] = await Promise.all([
    supabase
      .from('projects')
      .select('id, user_id, title, status, pipeline_status, pipeline_error, pipeline_progress_percent, pipeline_completed_at, source_type, source_url, source_storage_path, source_title, source_thumbnail_url, source_duration_seconds, created_at')
      .eq('id', projectId)
      .single(),
    loadProjectExports(supabase, projectId),
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
  const projectRow = projectResult.data;
  const candidateRows = candidateResult.data;
  const transcriptRow = transcriptResult.data;

  const candidatesById = new Map<string, CandidateRow>(((candidateRows ?? []) as CandidateRow[]).map((c) => [String(c.id), c]));

  const exportItems = await Promise.all(
    ((exportsRows ?? []) as ExportRow[]).map(async (row) => {
      let signedUrl: string | null = null;
      let posterUrl: string | null = null;
      const isMockExport = Boolean(row.output_storage_path?.startsWith('mock://'));
      if (row.output_storage_path && !row.output_storage_path.startsWith('/') && !isMockExport) {
        try {
          signedUrl = await createExportSignedUrl(row.output_storage_path, 60 * 60);
        } catch {
          signedUrl = null;
        }

        const posterPath = getExportPosterPath(row.output_storage_path);
        if (posterPath) {
          try {
            posterUrl = await createExportSignedUrl(posterPath, 60 * 60);
          } catch {
            posterUrl = null;
          }
        }
      }

      const candidate = row.clip_candidate_id ? candidatesById.get(String(row.clip_candidate_id)) : undefined;

      const editedStart = Number(row.clip_edit_settings?.clip_start_seconds);
      const editedEnd = Number(row.clip_edit_settings?.clip_end_seconds);
      const hasEditedWindow = Number.isFinite(editedStart) && Number.isFinite(editedEnd) && editedEnd > editedStart;
      const startSec = hasEditedWindow ? editedStart : candidate ? Number(candidate.start_sec) : null;
      const endSec = hasEditedWindow ? editedEnd : candidate ? Number(candidate.end_sec) : null;
      const derivedDuration = startSec != null && endSec != null ? Math.max(0, endSec - startSec) : 0;
      const durationSeconds = Number(derivedDuration ?? 0);
      const rawScore = Number(candidate?.overall_score ?? 0);
      const score = Math.max(70, Math.min(100, Math.round(rawScore <= 10 ? rawScore * 10 : rawScore)));

      return {
        ...row,
        signedUrl,
        posterUrl,
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
  const projectMarkedCompleted = projectRow?.status === 'completed'
    || projectRow?.pipeline_status === 'completed'
    || Boolean((projectRow as { pipeline_completed_at?: string | null } | null)?.pipeline_completed_at);
  const savedExportItems = filteredExportItems.filter(hasSavedPlayableOutput);
  const activeExportItems = filteredExportItems.filter((row) => (row.status === 'queued' || row.status === 'processing') && !hasSavedPlayableOutput(row));
  const hasActiveEditRenders = filteredExportItems.some((row) => row.edit_status === 'rendering');

  const pageTitle =
    typeof projectRow?.source_title === 'string' && projectRow.source_title.trim().length
      ? projectRow.source_title.trim()
      : typeof projectRow?.title === 'string' && projectRow.title.trim().length
        ? projectRow.title.trim()
        : 'Untitled video';
  const completedAt = projectMarkedCompleted
    ? ((projectRow as { pipeline_completed_at?: string | null } | null)?.pipeline_completed_at || projectRow?.created_at || null)
    : null;
  const expiryInfo = getProjectExpiryInfo(completedAt);

  if (expiryInfo.is_expired) {
    return (
      <main className="mx-auto w-full max-w-[1200px] px-8 py-16">
        <section className="mx-auto max-w-2xl rounded-3xl border border-white/10 bg-white/[0.035] p-8 text-center shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
          <p className="text-xs font-black uppercase tracking-[0.28em] text-white/40">Project expired</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-white">{pageTitle}</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-white/62">
            Finished projects are kept for {PROJECT_RETENTION_DAYS} days. This project has expired, so it is no longer available to open.
          </p>
        </section>
      </main>
    );
  }

  const transcriptSegments = Array.isArray(transcriptRow?.segments_json) ? (transcriptRow?.segments_json as { end?: number }[]) : [];
  const transcriptSeconds = transcriptSegments.reduce((acc, s) => Math.max(acc, Number(s?.end ?? 0)), 0);
  const sourceDurationSeconds = Number(projectRow?.source_duration_seconds ?? 0);
  const totalSeconds = transcriptSeconds > 0 ? transcriptSeconds : sourceDurationSeconds;
  const targetCount = Math.max(1, getTargetClipCount(totalSeconds));
  const doneExports = savedExportItems.length;
  const activeExports = activeExportItems.length;
  const rawProgressPercent = Number(projectRow?.pipeline_progress_percent ?? 0);
  const pipelineStatus = String(projectRow?.pipeline_status ?? 'idle');
  const projectHasTerminalIssue = String(projectRow?.status ?? '') === 'error' || pipelineStatus === 'error';
  const playableExportItems = filteredExportItems.filter(hasSavedPlayableOutput);
  const hasPlayableExports = playableExportItems.length > 0;
  const shouldShowResults = hasPlayableExports && (hasActiveEditRenders || activeExports === 0 || projectMarkedCompleted || projectHasTerminalIssue);
  const displayExportItems = shouldShowResults ? playableExportItems : [];
  const isCompletedFromRows = doneExports > 0 && (
    projectMarkedCompleted
    || (activeExports === 0 && (projectHasTerminalIssue || doneExports >= targetCount))
  );
  const effectiveStatus = isCompletedFromRows ? 'completed' : activeExports > 0 ? 'analyzed' : String(projectRow?.status ?? 'created');
  const progressPercent = isCompletedFromRows || (pipelineStatus === 'completed' && doneExports > 0)
    ? 100
    : Math.max(0, Math.min(98, Number.isFinite(rawProgressPercent) ? rawProgressPercent : 0));

  const youtubeId = parseYouTubeId(projectRow?.source_url ?? null);
  const fallbackThumbnail = stableYouTubeThumbnail(null, youtubeId);
  const refreshedUploadThumbnail = projectRow?.source_type === 'upload'
    ? await ensureProjectUploadThumbnail({
        id: String(projectRow?.id ?? projectId),
        user_id: String((projectRow as { user_id?: string | null } | null)?.user_id ?? ''),
        source_type: 'upload',
        source_storage_path: typeof (projectRow as { source_storage_path?: string | null } | null)?.source_storage_path === 'string'
          ? (projectRow as { source_storage_path?: string | null }).source_storage_path
          : null,
      }, { generateIfMissing: false }).catch(() => null)
    : null;
  const heroThumbnail = refreshedUploadThumbnail || projectRow?.source_thumbnail_url || fallbackThumbnail;
  const doneResultItems = savedExportItems;
  const hasRenderableResults = doneResultItems.some((row) => Boolean(row.signedUrl));
  const hasMockResults = doneResultItems.some((row) => row.output_storage_path?.startsWith('mock://'));
  const hasActiveExports = activeExports > 0;
  const hasExportRows = displayExportItems.length > 0;
  const waitingForPlayableReels =
    !shouldShowResults &&
    !hasExportRows &&
    !hasActiveExports &&
    !hasRenderableResults &&
    !hasMockResults &&
    (effectiveStatus === 'completed' || pipelineStatus === 'completed' || progressPercent >= 100);
  const showProcessingHero = !shouldShowResults && (!projectMarkedCompleted || hasActiveExports || !hasRenderableResults || hasMockResults || waitingForPlayableReels);

  return (
    <main className="mx-auto w-full max-w-[2400px] px-8 py-10">
      <section className="flex flex-col items-center">
        <div className="mb-8 w-full max-w-5xl text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">{pageTitle}</h1>
        </div>

        <div className="sr-only">
          <PipelineRunner projectId={projectId} autoStart={autoStart} />
        </div>

        {shouldShowResults ? (
          <TopClipsBoard
            projectId={projectId}
            clips={displayExportItems.map((row) => ({
              exportId: row.id,
              clipCandidateId: row.clip_candidate_id,
              title: row.title,
              score: row.score,
              status: row.status,
              errorMessage: row.error_message,
              signedUrl: row.signedUrl,
              posterUrl: row.posterUrl,
              startSec: row.startSec,
              endSec: row.endSec,
              reason: row.reason,
              rank: row.rank,
              captionPresetId: row.caption_preset_id,
              captionsEnabled: row.clip_edit_settings?.captions_enabled !== false,
              captionHighlightColor: row.clip_edit_settings?.caption_highlight_color ?? null,
              editStatus: row.edit_status ?? null,
              editStartedAt: row.updated_at ?? row.created_at,
            }))}
          />
        ) : showProcessingHero ? (
          <ProcessingHero
            projectId={projectId}
            pageTitle={pageTitle}
            heroThumbnail={heroThumbnail}
            fallbackPercent={progressPercent}
            fallbackTargetCount={targetCount}
            forcePreparing={waitingForPlayableReels || hasActiveEditRenders}
            watchActiveEdits={hasActiveEditRenders}
          />
        ) : null}
      </section>
    </main>
  );
}
