import { NextResponse } from 'next/server';
import { createProjectSchema } from '@/lib/validators';
import { createClient } from '@/lib/supabase/server';
import { fetchYouTubeSourceMetadata } from '@/lib/source-metadata';
import { createAdminClient } from '@/lib/supabase/admin';
import { PLAN_LOOKUP, type PlanId } from '@/lib/plans';
import { minutesRequiredFromSeconds } from '@/lib/billing';

const BILLING_DEV_BYPASS = process.env.NODE_ENV !== 'production' && process.env.BILLING_DEV_BYPASS === 'true';

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

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .from('projects')
      .select('id, title, status, pipeline_status, source_type, source_url, created_at, source_title, source_thumbnail_url, source_channel_name, source_duration_seconds, exports(status, output_storage_path)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const projects = (data ?? []).map((project) => {
      const rows = Array.isArray(project.exports) ? project.exports as Array<{ status?: string | null; output_storage_path?: string | null }> : [];
      const readyExports = rows.filter((r) => typeof r.output_storage_path === 'string' && r.output_storage_path.length > 0).length;
      const activeExports = rows.filter((r) => r.status === 'queued' || r.status === 'processing').length;
      const isCompleted = project.status === 'completed' || project.pipeline_status === 'completed' || (readyExports > 0 && activeExports === 0);

      return {
        ...project,
        status: isCompleted ? 'completed' : project.status,
        pipeline_status: isCompleted ? 'completed' : project.pipeline_status,
        progress_percent: isCompleted ? 100 : undefined,
        exports: undefined,
      };
    });

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
