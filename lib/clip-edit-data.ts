import { CAPTION_PRESETS } from '@/lib/caption-presets';
import {
  buildDefaultClipEditSettings,
  normalizeClipEditSettings,
  transcriptSegmentsToPhrases,
  type ClipEditSettings,
  type TranscriptSegment,
} from '@/lib/clip-edit';
import { createAdminClient } from '@/lib/supabase/admin';
import { createExportPreviewUrl, createExportSignedUrl, createRawMediaSignedUrl } from '@/lib/storage';

type ExportRow = {
  id: string;
  project_id: string;
  clip_candidate_id: string | null;
  status: string;
  output_storage_path: string | null;
  error_message: string | null;
  caption_preset_id: string | null;
  clip_edit_settings?: Record<string, unknown> | null;
  edit_status?: string | null;
  updated_at?: string | null;
  caption_edit_preview_provider?: 'r2' | 'supabase' | null;
  caption_edit_preview_storage_path?: string | null;
};

type ProjectRow = {
  id: string;
  user_id: string;
  title: string | null;
  source_type: 'youtube' | 'upload';
  source_url: string | null;
  source_storage_path: string | null;
  source_title: string | null;
  source_duration_seconds: number | null;
};

type CandidateRow = {
  id: string;
  title: string | null;
  start_sec: number;
  end_sec: number;
  overall_score: number | null;
  reason: string | null;
};

function maxTranscriptEnd(segments: TranscriptSegment[]) {
  return segments.reduce((max, segment) => Math.max(max, Number(segment.end ?? 0)), 0);
}

function exportPosterPath(outputPath: string | null) {
  if (!outputPath || outputPath.startsWith('/') || outputPath.startsWith('mock://')) return null;
  return /\.mp4$/i.test(outputPath) ? outputPath.replace(/\.mp4$/i, '.jpg') : null;
}

export function clipEditorErrorMessage(error: unknown, fallback = 'Could not load clip editor') {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const parts = [
      record.message,
      record.details,
      record.hint,
      record.code,
    ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    if (parts.length) return parts.join(' ');
    try {
      return JSON.stringify(record);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function isMissingEditColumnError(error: unknown) {
  const message = clipEditorErrorMessage(error, '');
  return /(clip_edit_settings|edit_status|caption_edit_preview)/i.test(message)
    && /(column|schema cache|could not find|PGRST204|42703)/i.test(message);
}

async function signedExportUrl(path: string | null) {
  if (!path || path.startsWith('/') || path.startsWith('mock://')) return null;
  try {
    return await createExportSignedUrl(path, 60 * 60);
  } catch {
    return null;
  }
}

async function signedRawUrl(path: string | null) {
  if (!path || path.startsWith('/')) return null;
  try {
    return await createRawMediaSignedUrl(path, 60 * 60);
  } catch {
    return null;
  }
}

export async function loadClipEditData(clipId: string, userId: string) {
  const supabase = createAdminClient();

  const exportLookup = await supabase
    .from('exports')
    .select('*')
    .eq('id', clipId)
    .maybeSingle();

  const fallbackExportLookup = exportLookup.error && isMissingEditColumnError(exportLookup.error)
    ? await supabase
        .from('exports')
        .select('id, project_id, clip_candidate_id, status, output_storage_path, error_message, caption_preset_id, updated_at')
        .eq('id', clipId)
        .maybeSingle()
    : null;

  const exportError = fallbackExportLookup?.error ?? exportLookup.error;
  const exportRow = fallbackExportLookup?.data
    ? { ...(fallbackExportLookup.data as ExportRow), clip_edit_settings: null, edit_status: null }
    : exportLookup.data;

  if (exportError) throw exportError;
  if (!exportRow) return null;

  const ex = exportRow as ExportRow;

  const [{ data: projectRow, error: projectError }, { data: candidateRow, error: candidateError }, { data: transcriptRow, error: transcriptError }] =
    await Promise.all([
      supabase
        .from('projects')
        .select('*')
        .eq('id', ex.project_id)
        .maybeSingle(),
      ex.clip_candidate_id
        ? supabase
            .from('clip_candidates')
            .select('*')
            .eq('id', ex.clip_candidate_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('transcripts')
        .select('segments_json')
        .eq('project_id', ex.project_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  if (projectError) throw projectError;
  if (candidateError) throw candidateError;
  if (transcriptError) throw transcriptError;
  if (!projectRow || String((projectRow as ProjectRow).user_id) !== userId) return null;

  const project = projectRow as ProjectRow;
  const candidate = candidateRow as CandidateRow | null;
  const transcriptSegments = Array.isArray(transcriptRow?.segments_json)
    ? (transcriptRow.segments_json as TranscriptSegment[])
    : [];
  const transcriptPhrases = transcriptSegmentsToPhrases(transcriptSegments);
  const aiStart = Number(candidate?.start_sec ?? 0);
  const aiEnd = Number(candidate?.end_sec ?? Math.max(10, aiStart + 30));
  const sourceDuration = Math.max(
    Number(project.source_duration_seconds ?? 0),
    maxTranscriptEnd(transcriptSegments),
    aiEnd,
  );
  const defaults = buildDefaultClipEditSettings({
    aiStart,
    aiEnd,
    sourceDuration,
    transcriptPhrases,
    captionPresetId: ex.caption_preset_id,
  });
  const settings = normalizeClipEditSettings(ex.clip_edit_settings, defaults, sourceDuration);
  const clipUrl = await signedExportUrl(ex.output_storage_path);
  const posterUrl = await signedExportUrl(exportPosterPath(ex.output_storage_path));
  const sourcePreviewUrl = await signedRawUrl(project.source_storage_path);
  const captionEditPreviewUrl = ex.caption_edit_preview_storage_path
    ? await createExportPreviewUrl(ex.caption_edit_preview_provider ?? 'supabase', ex.caption_edit_preview_storage_path, 60 * 60).catch(() => null)
    : null;

  return {
    project: {
      id: project.id,
      title: project.source_title || project.title || 'Untitled project',
      sourceType: project.source_type,
      sourceDurationSeconds: sourceDuration,
    },
    clip: {
      id: ex.id,
      projectId: ex.project_id,
      candidateId: ex.clip_candidate_id,
      title: candidate?.title || 'Untitled clip',
      aiStartSeconds: aiStart,
      aiEndSeconds: aiEnd,
      score: Number(candidate?.overall_score ?? 0),
      reason: candidate?.reason ?? null,
      status: ex.status,
      editStatus: ex.edit_status ?? 'idle',
      errorMessage: ex.error_message ?? null,
      signedUrl: clipUrl,
      posterUrl,
      updatedAt: ex.updated_at ?? null,
    },
    source: {
      previewUrl: captionEditPreviewUrl ?? sourcePreviewUrl,
      previewKind: captionEditPreviewUrl ? 'caption-free-reel' : sourcePreviewUrl ? 'source' : 'burned-reel',
      fallbackClipUrl: clipUrl,
      posterUrl,
      durationSeconds: sourceDuration,
    },
    transcript: {
      segments: transcriptSegments,
      phrases: transcriptPhrases,
    },
    settings,
    presets: CAPTION_PRESETS,
  };
}

export function sanitizeClipEditPayload(
  raw: unknown,
  current: Awaited<ReturnType<typeof loadClipEditData>>,
): ClipEditSettings {
  if (!current) throw new Error('Clip not found');
  return normalizeClipEditSettings(raw, current.settings, current.source.durationSeconds);
}
