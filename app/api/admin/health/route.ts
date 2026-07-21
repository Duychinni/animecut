import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const admin = createAdminClient();
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [queued, processing, failed, stale, billing] = await Promise.all([
    admin.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
    admin.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'processing'),
    admin.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'error'),
    admin.from('projects').select('id,title,pipeline_stage,worker_last_seen_at,updated_at').eq('pipeline_status', 'processing').lt('worker_last_seen_at', staleBefore).order('updated_at', { ascending: true }).limit(25),
    admin.from('billing_events').select('stripe_event_id,event_type,processed_at').order('processed_at', { ascending: false }).limit(20),
  ]);
  const firstError = [queued.error, processing.error, failed.error, stale.error].find(Boolean);
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 500 });
  return NextResponse.json({
    checked_at: new Date().toISOString(),
    jobs: { queued: queued.count ?? 0, processing: processing.count ?? 0, failed: failed.count ?? 0 },
    stale_projects: stale.data ?? [],
    recent_billing_events: billing.error ? [] : billing.data ?? [],
    configuration: {
      sentry: Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN),
      posthog: Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY),
      stripe_webhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      email: Boolean(process.env.RESEND_API_KEY || process.env.SMTP_HOST),
    },
  });
}
