import { NextResponse } from 'next/server';
import { createProjectSchema } from '@/lib/validators';
import { createClient } from '@/lib/supabase/server';
import { fetchYouTubeSourceMetadata, stableYouTubeThumbnail } from '@/lib/source-metadata';
import { createAdminClient } from '@/lib/supabase/admin';
import { FREE_TRIAL_MAX_UPLOAD_MINUTES, FREE_TRIAL_UPLOADS, PLAN_LOOKUP, type PlanId } from '@/lib/plans';
import { getOrCreateProfile, minutesRequiredFromSeconds } from '@/lib/billing';
import { isMockAiEnabled } from '@/lib/dev-ai';
import { getProjectExpiryInfo } from '@/lib/project-retention';
import { fetchYouTubeDurationSeconds } from '@/lib/youtube';
import { getTargetClipCount } from '@/lib/clip-policy';
import { isSupportedYouTubeVideoUrl, YOUTUBE_LINK_ERROR } from '@/lib/youtube-url';

const BILLING_DEV_BYPASS = (process.env.NODE_ENV !== 'production' && process.env.BILLING_DEV_BYPASS === 'true') || isMockAiEnabled();

function hasPlayableOutput(row: { status?: string | null; output_storage_path?: string | null }) {
  return row.status !== 'error'
    && typeof row.output_storage_path === 'string'
    && row.output_storage_path.length > 0
    && !row.output_storage_path.startsWith('mock://');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  if (typeof error === 'object' && error !== null) {
    const withFields = error as {
      message?: string;
      error_description?: string;
      details?: string;
    };
    return withFields.message || withFields.error_description || withFields.details || JSON.stringify(error);
  }

  return 'Unknown error';
}

function parseYouTubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] ?? null;
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    return null;
  } catch {
    return null;
  }
}

function estimateDashboardEtaSeconds(params: {
  status: string | null;
  pipelineStatus: string | null;
  pipelineStage: string | null;
  progressPercent: number;
  sourceDurationSeconds: number | null;
  readyExports: number;
  activeExports: number;
  exportCount: number;
}) {
  const {
    status,
    pipelineStatus,
    pipelineStage,
    progressPercent,
    sourceDurationSeconds,
    readyExports,
    activeExports,
    exportCount,
  } = params;

  if (status === 'completed' || pipelineStatus === 'completed') return 0;
  if (status === 'failed' || status === 'error' || pipelineStatus === 'error') return null;
  if (pipelineStatus !== 'queued' && pipelineStatus !== 'processing') return null;

  const sourceSeconds = Math.max(60, Number(sourceDurationSeconds) || 600);
  const targetCount = Math.max(1, exportCount || getTargetClipCount(sourceSeconds));
  const remainingExports = Math.max(0, targetCount - readyExports);
  const renderParallelism = Math.max(1, Math.min(3, activeExports || 2));
  const renderBudget = Math.max(35, Math.round((Math.max(1, remainingExports) * 50) / renderParallelism));
  const stageBudgets: Record<string, number> = {
    queued: 20,
    downloading: Math.max(25, Math.min(90, Math.round(sourceSeconds * 0.06))),
    extracting_audio: Math.max(20, Math.min(80, Math.round(sourceSeconds * 0.08))),
    transcribing: Math.max(45, Math.min(240, Math.round(sourceSeconds * 0.22))),
    diarizing: Math.max(25, Math.min(150, Math.round(sourceSeconds * 0.12))),
    finding_hooks: Math.max(30, Math.min(120, Math.round(sourceSeconds * 0.1))),
    creating_clips: 18,
    face_tracking_crop: Math.max(15, Math.min(80, remainingExports * 8)),
    rendering: renderBudget,
    uploading_outputs: 12,
  };
  const stageStarts: Record<string, number> = {
    queued: 0,
    downloading: 5,
    extracting_audio: 10,
    transcribing: 25,
    diarizing: 32,
    finding_hooks: 40,
    creating_clips: 55,
    face_tracking_crop: 70,
    rendering: 85,
    uploading_outputs: 95,
  };
  const stageOrder = ['queued', 'downloading', 'extracting_audio', 'transcribing', 'diarizing', 'finding_hooks', 'creating_clips', 'face_tracking_crop', 'rendering', 'uploading_outputs'];
  const effectiveStage = pipelineStage && stageBudgets[pipelineStage] ? pipelineStage : pipelineStatus === 'queued' ? 'queued' : 'transcribing';
  const currentIndex = Math.max(0, stageOrder.indexOf(effectiveStage));
  const stageStart = stageStarts[effectiveStage] ?? 0;
  const nextStageStart = currentIndex + 1 < stageOrder.length ? (stageStarts[stageOrder[currentIndex + 1]] ?? 100) : 100;
  const stageFraction = Math.max(0, Math.min(0.95, (progressPercent - stageStart) / Math.max(1, nextStageStart - stageStart)));
  const currentRemaining = Math.max(5, Math.round((stageBudgets[effectiveStage] ?? 30) * (1 - stageFraction)));
  const futureSeconds = stageOrder.slice(currentIndex + 1).reduce((total, stage) => total + (stageBudgets[stage] ?? 0), 0);

  return Math.max(8, currentRemaining + futureSeconds);
}

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .from('projects')
      .select('id, user_id, title, status, pipeline_status, pipeline_stage, pipeline_stage_label, pipeline_progress_percent, pipeline_error, worker_last_seen_at, pipeline_completed_at, source_type, source_url, source_storage_path, created_at, source_title, source_thumbnail_url, source_channel_name, source_duration_seconds, exports(status, output_storage_path)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const projects = await Promise.all((data ?? []).map(async (project) => {
      const rows = Array.isArray(project.exports) ? project.exports as Array<{ status?: string | null; output_storage_path?: string | null }> : [];
      const readyExports = rows.filter(hasPlayableOutput).length;
      const queuedExports = rows.filter((r) => r.status === 'queued' && !hasPlayableOutput(r)).length;
      const processingExports = rows.filter((r) => r.status === 'processing' && !hasPlayableOutput(r)).length;
      const activeExports = queuedExports + processingExports;
      const targetExports = Math.max(1, rows.length || getTargetClipCount(Math.max(60, Number(project.source_duration_seconds) || 600)));
      const markedCompleted = project.status === 'completed' || project.pipeline_status === 'completed';
      const completionLatched = markedCompleted || Boolean(project.pipeline_completed_at);
      // Completion must be an explicit durable backend decision. Inferring it
      // from a moment with zero active exports made cards briefly look ready
      // between render/refill jobs, then return to processing after opening.
      const isCompleted = readyExports > 0 && completionLatched;
      const needsExportCompletion = markedCompleted && readyExports === 0;
      const uploadThumbnailUrl = project.source_type === 'upload'
        ? project.source_thumbnail_url
        : null;
      const sourceThumbnailUrl = project.source_type === 'youtube'
        ? stableYouTubeThumbnail(project.source_thumbnail_url, parseYouTubeId(project.source_url))
        : uploadThumbnailUrl || project.source_thumbnail_url;
      const expiryInfo = getProjectExpiryInfo(isCompleted ? (project.pipeline_completed_at || project.created_at) : null);
      const progressPercent = isCompleted ? 100 : Number(project.pipeline_progress_percent ?? 0);
      const normalizedStatus = isCompleted ? 'completed' : needsExportCompletion || activeExports > 0 ? 'analyzed' : project.status;
      const normalizedPipelineStatus = isCompleted ? 'completed' : needsExportCompletion || activeExports > 0 ? 'processing' : project.pipeline_status;
      const normalizedPipelineStage = isCompleted ? 'completed' : activeExports > 0 ? 'rendering' : project.pipeline_stage;
      const normalizedPipelineStageLabel = isCompleted
        ? 'Completed'
        : processingExports > 0
          ? `Rendering reels (${readyExports}/${targetExports} ready)`
          : queuedExports > 0
            ? `Waiting for render worker (${readyExports}/${targetExports} ready)`
            : project.pipeline_stage_label;
      const etaSeconds = estimateDashboardEtaSeconds({
        status: normalizedStatus,
        pipelineStatus: normalizedPipelineStatus,
        pipelineStage: normalizedPipelineStage,
        progressPercent,
        sourceDurationSeconds: project.source_duration_seconds,
        readyExports,
        activeExports,
        exportCount: targetExports,
      });
      const hasActivePipeline = normalizedPipelineStatus === 'queued' || normalizedPipelineStatus === 'processing';

      return {
        ...project,
        status: normalizedStatus,
        pipeline_status: normalizedPipelineStatus,
        pipeline_stage: normalizedPipelineStage,
        pipeline_stage_label: normalizedPipelineStageLabel,
        pipeline_error: activeExports > 0 || isCompleted ? null : project.pipeline_error,
        progress_percent: progressPercent,
        // The estimator covers the full pipeline, not only FFmpeg rendering.
        // Returning it throughout an active run keeps the dashboard ETA visible
        // while downloading, transcribing, analyzing, queuing, and rendering.
        eta_seconds: hasActivePipeline ? etaSeconds : null,
        done_exports: readyExports,
        active_exports: activeExports,
        queued_exports: queuedExports,
        processing_exports: processingExports,
        target_exports: targetExports,
        source_thumbnail_url: sourceThumbnailUrl,
        expires_at: expiryInfo.expires_at,
        days_until_expiring: expiryInfo.days_until_expiring,
        is_expired: expiryInfo.is_expired,
        user_id: undefined,
        pipeline_completed_at: undefined,
        source_storage_path: undefined,
        exports: undefined,
      };
    }));

    return NextResponse.json({ projects: projects.filter((project) => !project.is_expired) });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = createProjectSchema.parse(body);
    if (parsed.source_type === 'youtube' && !isSupportedYouTubeVideoUrl(parsed.source_url)) {
      return NextResponse.json({ error: YOUTUBE_LINK_ERROR }, { status: 400 });
    }
    const supabase = await createClient();

    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sourceMeta =
      parsed.source_type === 'youtube' && parsed.source_url
        ? await fetchYouTubeSourceMetadata(parsed.source_url)
        : {
            sourceUrl: parsed.source_url ?? null,
            sourcePlatform: parsed.source_type,
            sourceVideoId: null,
            sourceTitle: parsed.title,
            sourceThumbnailUrl: null,
            sourceChannelName: null,
            sourceDurationSeconds: parsed.source_duration_seconds ?? null,
          };

    const admin = createAdminClient();
    // Ensure every authenticated user has the persisted one-time allowance.
    // Falling back to an in-memory default when a profile row is missing would
    // let the same account create more than one free project.
    const profile = await getOrCreateProfile(user.id);

    const planId = (profile?.subscription_plan ?? 'free') as PlanId;
    const configuredPlan = planId === 'starter' || planId === 'creator' || planId === 'pro' ? PLAN_LOOKUP[planId] : null;
    if (planId === 'free' && parsed.source_type === 'youtube' && !sourceMeta.sourceDurationSeconds && parsed.source_url) {
      sourceMeta.sourceDurationSeconds = await fetchYouTubeDurationSeconds(parsed.source_url);
    }
    const uploadMinutes = minutesRequiredFromSeconds(sourceMeta.sourceDurationSeconds);

    if (!BILLING_DEV_BYPASS) {
      if (planId === 'free' && uploadMinutes <= 0) {
        return NextResponse.json(
          {
            error: 'We could not verify this video\'s length for the free test. Try the link again or upload the video file instead.',
          },
          { status: 400 },
        );
      }

      if (planId === 'free' && uploadMinutes > FREE_TRIAL_MAX_UPLOAD_MINUTES) {
        return NextResponse.json(
          {
            error: `Videos on the free plan must be ${FREE_TRIAL_MAX_UPLOAD_MINUTES} minutes or under. Choose a shorter video or upgrade to continue.`,
          },
          { status: 400 },
        );
      }

      if (configuredPlan?.maxUploadLengthMinutes && uploadMinutes > configuredPlan.maxUploadLengthMinutes) {
        return NextResponse.json(
          {
            error: `This upload is too long for your ${configuredPlan.name} plan. Maximum upload length is ${configuredPlan.maxUploadLengthMinutes} minutes.`,
          },
          { status: 400 },
        );
      }

      if (planId === 'free') {
        const freeUploadsRemaining = Number(profile?.free_uploads_remaining ?? FREE_TRIAL_UPLOADS);
        if (freeUploadsRemaining <= 0) {
          return NextResponse.json(
            {
              error: 'Your free upload has already been used. Upgrade your plan to continue creating clips.',
            },
            { status: 402 },
          );
        }
      } else if (uploadMinutes > 0) {
        const remaining = Number(profile?.processing_minutes_remaining ?? 0);
        if (remaining < uploadMinutes) {
          return NextResponse.json(
            {
              error: `You only have ${remaining} processing minutes remaining. This upload requires ${uploadMinutes} minutes. Upgrade your plan or wait until your next billing cycle.`,
            },
            { status: 402 },
          );
        }
      }
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        title: sourceMeta.sourceTitle || parsed.title,
        source_type: parsed.source_type,
        source_url: parsed.source_url ?? null,
        source_platform: sourceMeta.sourcePlatform,
        source_video_id: sourceMeta.sourceVideoId,
        source_title: sourceMeta.sourceTitle,
        source_thumbnail_url: sourceMeta.sourceThumbnailUrl,
        source_channel_name: sourceMeta.sourceChannelName,
        source_duration_seconds: sourceMeta.sourceDurationSeconds,
        content_rights_confirmed_at: new Date().toISOString(),
        status: 'created',
      })
      .select('*')
      .single();

    if (error) throw error;

    if (!BILLING_DEV_BYPASS) {
      if (planId === 'free') {
        const freeUploadsRemaining = Math.max(0, Number(profile?.free_uploads_remaining ?? FREE_TRIAL_UPLOADS) - 1);
        await admin.from('profiles').update({ free_uploads_remaining: freeUploadsRemaining, updated_at: new Date().toISOString() }).eq('id', user.id);
        await admin.from('usage_ledger').insert({
          user_id: user.id,
          project_id: data.id,
          usage_type: 'free_upload',
          quantity: 1,
          notes: 'Free trial upload used',
        });
      } else if (uploadMinutes > 0) {
        const currentRemaining = Number(profile?.processing_minutes_remaining ?? 0);
        const currentUsed = Number(profile?.processing_minutes_used ?? 0);
        await admin
          .from('profiles')
          .update({
            processing_minutes_used: currentUsed + uploadMinutes,
            processing_minutes_remaining: Math.max(0, currentRemaining - uploadMinutes),
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id);
        await admin.from('usage_ledger').insert({
          user_id: user.id,
          project_id: data.id,
          usage_type: 'processing_minutes',
          quantity: uploadMinutes,
          notes: 'Reserved at project creation based on uploaded source duration',
        });
      }
    }

    return NextResponse.json({ project: data, devBypass: BILLING_DEV_BYPASS });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
