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
      .select('id, user_id, title, status, pipeline_status, pipeline_stage, pipeline_stage_label, pipeline_progress_percent, pipeline_error, worker_last_seen_at, pipeline_completed_at, source_type, source_url, source_storage_path, created_at, source_title, source_thumbnail_url, source_channel_name, source_duration_seconds, exports(status, output_storage_path)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const projects = await Promise.all((data ?? []).map(async (project) => {
      const rows = Array.isArray(project.exports) ? project.exports as Array<{ status?: string | null; output_storage_path?: string | null }> : [];
      const readyExports = rows.filter(hasPlayableOutput).length;
      const activeExports = rows.filter((r) => (r.status === 'queued' || r.status === 'processing') && !hasPlayableOutput(r)).length;
      const markedCompleted = project.status === 'completed' || project.pipeline_status === 'completed';
      const completionLatched = markedCompleted || Boolean(project.pipeline_completed_at);
      const isCompleted = readyExports > 0 && (completionLatched || activeExports === 0);
      const needsExportCompletion = markedCompleted && readyExports === 0;
      const uploadThumbnailUrl = project.source_type === 'upload'
        ? project.source_thumbnail_url
        : null;
      const sourceThumbnailUrl = project.source_type === 'youtube'
        ? stableYouTubeThumbnail(project.source_thumbnail_url, parseYouTubeId(project.source_url))
        : uploadThumbnailUrl || project.source_thumbnail_url;
      const expiryInfo = getProjectExpiryInfo(isCompleted ? (project.pipeline_completed_at || project.created_at) : null);

      return {
        ...project,
        status: isCompleted ? 'completed' : needsExportCompletion ? 'analyzed' : project.status,
        pipeline_status: isCompleted ? 'completed' : needsExportCompletion ? 'processing' : project.pipeline_status,
        progress_percent: isCompleted ? 100 : Number(project.pipeline_progress_percent ?? 0),
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
            error: `Your free test video can be up to ${FREE_TRIAL_MAX_UPLOAD_MINUTES} minutes long. Choose a shorter video or upgrade to continue.`,
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
