import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

function StatCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <p className="text-xs uppercase tracking-[0.14em] text-white/45">{label}</p>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      <p className="mt-1 text-xs text-white/55">{hint}</p>
    </div>
  );
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let totalProjects = 0;
  let totalCandidates = 0;
  let completedExports = 0;

  if (user) {
    const [{ count: projectsCount }, { data: projectIds }, { count: exportsCount }] = await Promise.all([
      supabase.from('projects').select('*', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('projects').select('id').eq('user_id', user.id),
      supabase.from('exports').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    ]);

    totalProjects = projectsCount ?? 0;

    const ids = (projectIds ?? []).map((p) => p.id);
    if (ids.length) {
      const { count: candidatesCount } = await supabase
        .from('clip_candidates')
        .select('*', { count: 'exact', head: true })
        .in('project_id', ids);
      totalCandidates = candidatesCount ?? 0;

      const { count: userCompletedExports } = await supabase
        .from('exports')
        .select('*', { count: 'exact', head: true })
        .in('project_id', ids)
        .eq('status', 'completed');
      completedExports = userCompletedExports ?? exportsCount ?? 0;
    }
  }

  return (
    <main className="min-h-screen bg-[#0a0a0f] text-white">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <header className="mb-8 flex items-center justify-between border-b border-white/10 pb-4">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="mt-1 text-sm text-white/65">Create project → transcribe → analyze → export.</p>
          </div>
          <Link href="/" className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:border-white/40">
            Back to home
          </Link>
        </header>

        <section className="mb-5 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="text-lg font-semibold">Workspace Snapshot</h2>
          <p className="mt-1 text-sm text-white/65">Quick pulse on your clip production flow.</p>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <StatCard label="Projects" value={totalProjects} hint="Total created" />
            <StatCard label="Clip Candidates" value={totalCandidates} hint="AI-ranked moments" />
            <StatCard label="Exports Done" value={completedExports} hint="Render-complete clips" />
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="text-lg font-semibold">Projects Workspace</h2>
          <p className="mt-2 text-sm text-white/70">Manage uploads, run analysis, and generate export-ready clips from one place.</p>
          <Link
            href="/dashboard/projects"
            className="mt-5 inline-flex rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
          >
            Open Projects
          </Link>
        </section>
      </div>
    </main>
  );
}
