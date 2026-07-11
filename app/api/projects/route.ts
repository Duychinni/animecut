import { NextResponse } from 'next/server';
import { createProjectSchema } from '@/lib/validators';
import { createClient } from '@/lib/supabase/server';
import { fetchYouTubeSourceMetadata, stableYouTubeThumbnail } from '@/lib/source-metadata';
import { createAdminClient } from '@/lib/supabase/admin';
import { PLAN_LOOKUP, type PlanId } from '@/lib/plans';
import { minutesRequiredFromSeconds } from '@/lib/billing';
import { isMockAiEnabled } from '@/lib/dev-ai';
import { ensureProjectUploadThumbnail } from '@/lib/upload-thumbnail';

const BILLING_DEV_BYPASS = (process.env.NODE_ENV !== 'production' && process.env.BILLING_DEV_BYPASS === 'true') || isMockAiEnabled();
const PROJECT_RETENTION_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getExpiryInfo(completedAt: string | null | undefined) {
  if (!completedAt) {
    return { expires_at: null, days_until_expiring: null };
  }

  const baseMs = new Date(completedAt).getTime();
  if (!Number.isFinite(baseMs)) {
    return { expires_at: null, days_until_expiring: null };
  }

  const expiresMs = baseMs + PROJECT_RETENTION_DAYS * MS_PER_DAY;
  return {
    expires_at: new Date(expiresMs).toISOString(),
    days_until_expiring: Math.max(0, Math.ceil((expiresMs - Date.now()) / MS_PER_DAY)),
  };
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
      .select('id, user_id, title, status, pipeline_status, pipeline_completed_at, source_type, source_url, source_storage_path, created_at, source_title, source_thumbnail_url, source_channel_name, source_duration_seconds, exports(status, output_storage_path)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const projects = await Promise.all((data ?? []).map(async (project) => {
      const rows = Array.isArray(project.exports) ? project.exports as Array<{ status?: string | null; output_storage_path?: string | null }> : [];
      const readyExports = rows.filter((r) => r.status === 'done' && typeof r.output_storage_path === 'string' && r.output_storage_path.length > 0).length;
      const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length;
      const markedCompleted = project.status === 'completed' || project.pipeline_status === 'completed';
      const isCompleted = readyExports > 0 && activeExports === 0;
      const needsExportCompletion = markedCompleted && activeExports > 0;
      const uploadThumbnailUrl = project.source_type === 'upload'
        ? await ensureProjectUploadThumbnail({
            id: String(project.id),
            user_id: String(project.user_id),
            source_type: 'upload',
            source_storage_path: typeof project.source_storage_path === 'string' ? project.source_storage_path : null,
          }, { generateIfMissing: false }).catch(() => null)
        : null;
      const sourceThumbnailUrl = project.source_type === 'youtube'
        ? stableYouTubeThumbnail(project.source_thumbnail_url, parseYouTubeId(project.source_url))
        : uploadThumbnailUrl || project.source_thumbnail_url;
      const expiryInfo = getExpiryInfo(isCompleted ? (project.pipeline_completed_at || project.created_at) : null);

      return {
        ...project,
        status: isCompleted ? 'completed' : needsExportCompletion ? 'analyzed' : project.status,
        pipeline_status: isCompleted ? 'completed' : needsExportCompletion ? 'processing' : project.pipeline_status,
        source_thumbnail_url: sourceThumbnailUrl,
        progress_percent: isCompleted ? 100 : undefined,
        expires_at: expiryInfo.expires_at,
        days_until_expiring: expiryInfo.days_until_expiring,
        user_id: undefined,
        pipeline_completed_at: undefined,
        source_storage_path: undefined,
        exports: undefined,
      };
    }));

    return NextResponse.json({ projects });
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
            sourceDurationSeconds: null,
          };

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('subscription_plan, processing_minutes_remaining, processing_minutes_used, free_uploads_remaining')
      .eq('id', user.id)
      .maybeSingle();

    const planId = (profile?.subscription_plan ?? 'free') as PlanId;
    const configuredPlan = planId === 'starter' || planId === 'pro' ? PLAN_LOOKUP[planId] : null;
    const uploadMinutes = minutesRequiredFromSeconds(sourceMeta.sourceDurationSeconds);

    if (!BILLING_DEV_BYPASS) {
      if (configuredPlan?.maxUploadLengthMinutes && uploadMinutes > configuredPlan.maxUploadLengthMinutes) {
        return NextResponse.json(
          {
            error: `This upload is too long for your ${configuredPlan.name} plan. Maximum upload length is ${configuredPlan.maxUploadLengthMinutes} minutes.`,
          },
          { status: 400 },
        );
      }

      if (planId === 'free') {
        const freeUploadsRemaining = Number(profile?.free_uploads_remaining ?? 1);
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
        const freeUploadsRemaining = Math.max(0, Number(profile?.free_uploads_remaining ?? 1) - 1);
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
