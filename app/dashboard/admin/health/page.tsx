import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireAdmin } from '@/lib/admin-auth';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function AdminHealthPage() {
  if (!await requireAdmin()) redirect('/dashboard');
  const admin = createAdminClient();
  // Server-only operational snapshot; freshness is intentionally evaluated at request time.
  // eslint-disable-next-line react-hooks/purity
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [queued, processing, failed, stale, billing] = await Promise.all([
    admin.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
    admin.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'processing'),
    admin.from('jobs').select('*', { count: 'exact', head: true }).eq('status', 'error'),
    admin.from('projects').select('id,title,pipeline_stage,worker_last_seen_at').eq('pipeline_status', 'processing').lt('worker_last_seen_at', staleBefore).limit(25),
    admin.from('billing_events').select('stripe_event_id,event_type,processed_at').order('processed_at', { ascending: false }).limit(15),
  ]);
  const cards = [['Queued jobs', queued.count ?? 0], ['Processing jobs', processing.count ?? 0], ['Failed jobs', failed.count ?? 0], ['Stale projects', stale.data?.length ?? 0]];
  return <main className="mx-auto w-full max-w-5xl px-6 py-10"><Link href="/dashboard" className="text-sm text-white/60">← Dashboard</Link><h1 className="mt-5 text-3xl font-bold">Operations health</h1><p className="mt-2 text-sm text-white/55">Live queue and billing-webhook visibility. Processing with no heartbeat for ten minutes is considered stale.</p><div className="mt-7 grid gap-4 sm:grid-cols-4">{cards.map(([label,value]) => <div key={String(label)} className="rounded-2xl border border-white/10 bg-white/[0.04] p-5"><p className="text-xs text-white/50">{label}</p><p className="mt-2 text-3xl font-bold">{value}</p></div>)}</div><section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-bold">Stale projects</h2><div className="mt-3 space-y-2 text-sm text-white/65">{(stale.data ?? []).map((row) => <Link className="block underline" key={row.id} href={`/dashboard/projects/${row.id}`}>{row.title} · {row.pipeline_stage || 'unknown stage'} · last seen {row.worker_last_seen_at || 'never'}</Link>)}{!stale.data?.length ? <p>None</p> : null}</div></section><section className="mt-7 rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-bold">Recent Stripe webhooks</h2><div className="mt-3 space-y-2 font-mono text-xs text-white/60">{billing.error ? <p>Billing event table unavailable: {billing.error.message}</p> : (billing.data ?? []).map((row) => <p key={row.stripe_event_id}>{row.processed_at} · {row.event_type}</p>)}</div></section></main>;
}
