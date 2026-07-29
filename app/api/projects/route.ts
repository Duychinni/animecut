import { NextResponse } from 'next/server';
import { createProjectSchema, MAX_SOURCE_DURATION_SECONDS } from '@/lib/validators';
import { createClient } from '@/lib/supabase/server';
import { fetchYouTubeSourceMetadata, stableYouTubeThumbnail } from '@/lib/source-metadata';
import { createAdminClient } from '@/lib/supabase/admin';
import { FREE_TRIAL_MAX_UPLOAD_MINUTES, FREE_TRIAL_UPLOADS, PLAN_LOOKUP, type PlanId } from '@/lib/plans';
import { effectivePlanId, getOrCreateProfile, minutesRequiredFromSeconds } from '@/lib/billing';
import { isMockAiEnabled } from '@/lib/dev-ai';
import { getProjectExpiryInfo } from '@/lib/project-retention';
import { fetchYouTubeDurationSeconds } from '@/lib/youtube';
import { isSupportedYouTubeVideoUrl, YOUTUBE_LINK_ERROR } from '@/lib/youtube-url';
import { estimateObservedRenderEtaSeconds } from '@/lib/project-eta';
import { clampProgressToStage } from '@/lib/project-progress';
import { ensurePipelineJob } from '@/lib/pipeline';

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

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .from('projects')
      .select('id, user_id, title, status, pipeline_status, pipeline_stage, pipeline_stage_label, pipeline_progress_percent, pipeline_error, worker_last_seen_at, pipeline_completed_at, source_type, source_url, source_storage_path, created_at, source_title, source_thumbnail_url, source_channel_name, source_duration_seconds, exports(status, output_storage_path, created_at, updated_at)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const projects = await Promise.all((data ?? []).map(async (project) => {
      const rows = Array.isArray(project.exports) ? project.exports as Array<{
        status?: string | null;
        output_storage_path?: string | null;
        created_at?: string | null;
        updated_at?: string | null;
      }> : [];
      const readyExports = rows.filter(hasPlayableOutput).length;
      const queuedExports = rows.filter((r) => r.status === 'queued' && !hasPlayableOutput(r)).length;
      const processingExports = rows.filter((r) => r.status === 'processing' && !hasPlayableOutput(r)).length;
      const activeExports = queuedExports + processingExports;
      // Do not present the duration-based analysis goal as the number of reels
      // that will render. The render total is only final once export rows have
      // been created from the approved candidates.
      const targetExports = rows.length;
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
      const progressPercent = clampProgressToStage(
        Number(project.pipeline_progress_percent ?? 0),
        project.pipeline_stage,
        isCompleted,
      );
      const normalizedStatus = isCompleted ? 'completed' : needsExportCompletion || activeExports > 0 ? 'analyzed' : project.status;
      const normalizedPipelineStatus = isCompleted ? 'completed' : needsExportCompletion || activeExports > 0 ? 'processing' : project.pipeline_status;
      const normalizedPipelineStage = isCompleted ? 'completed' : activeExports > 0 ? 'rendering' : project.pipeline_stage;
      const normalizedPipelineStageLabel = isCompleted
        ? 'Completed'
        : processingExports > 0
          ? 'Rendering reels'
          : queuedExports > 0
            ? 'Waiting for render worker'
            : project.pipeline_stage_label;
      const etaSeconds = isCompleted ? 0 : estimateObservedRenderEtaSeconds({
        pipelineStatus: normalizedPipelineStatus,
        pipelineStage: normalizedPipelineStage,
        readyExports,
        exportCount: targetExports,
        exportRows: rows,
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

    const planId = effectivePlanId(profile) as PlanId;
    const configuredPlan = planId === 'starter' || planId === 'creator' || planId === 'pro' ? PLAN_LOOKUP[planId] : null;
    if (parsed.source_type === 'youtube' && !sourceMeta.sourceDurationSeconds && parsed.source_url) {
      sourceMeta.sourceDurationSeconds = await fetchYouTubeDurationSeconds(parsed.source_url);
    }
    const uploadMinutes = minutesRequiredFromSeconds(sourceMeta.sourceDurationSeconds);

    if (!BILLING_DEV_BYPASS) {
      if (Number(sourceMeta.sourceDurationSeconds ?? 0) > MAX_SOURCE_DURATION_SECONDS) {
        return NextResponse.json(
          { error: 'Source videos must be 5 hours or under.' },
          { status: 400 },
        );
      }
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
        pipeline_status: 'queued',
        pipeline_stage: 'queued',
        pipeline_stage_label: 'Starting processing',
        pipeline_progress_percent: 1,
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

    // YouTube sources are ready as soon as the project exists. Queue the job
    // here so the browser can navigate straight to a durable processing card
    // without a second request creating a visible "created" gap.
    if (parsed.source_type === 'youtube') {
      await ensurePipelineJob(data.id);
    }

    return NextResponse.json({
      project: {
        ...data,
        pipeline_status: parsed.source_type === 'youtube' ? 'queued' : data.pipeline_status,
        pipeline_stage: parsed.source_type === 'youtube' ? 'queued' : data.pipeline_stage,
        pipeline_stage_label: parsed.source_type === 'youtube' ? 'Starting processing' : data.pipeline_stage_label,
        pipeline_progress_percent: parsed.source_type === 'youtube' ? 1 : data.pipeline_progress_percent,
      },
      pipelineStarted: parsed.source_type === 'youtube',
      devBypass: BILLING_DEV_BYPASS,
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
