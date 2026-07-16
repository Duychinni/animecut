import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { createClient } from '@/lib/supabase/server';

export default async function EmailConfirmedPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <HomeLogoLink />
          <Link href="/dashboard" className="rounded-xl border border-white/15 bg-white/[0.03] px-4 py-2 text-sm font-semibold text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">
            Dashboard
          </Link>
        </header>

        <section className="mx-auto flex min-h-[72vh] max-w-xl items-center justify-center py-16">
          <div className="w-full rounded-[32px] border border-white/10 bg-white/[0.04] p-8 text-center shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:p-12">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-emerald-300/30 bg-emerald-400/10 text-3xl text-emerald-300 shadow-[0_0_35px_rgba(52,211,153,0.18)]">
              ✓
            </div>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.22em] text-emerald-300">Email confirmed</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Your AnimaCut account is ready.</h1>
            <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-white/65 sm:text-base">
              {user?.email
                ? `${user.email} has been verified. You can now use your free test project with up to 20 minutes of source video.`
                : 'Your email confirmation link was accepted. Sign in to start your free test project.'}
            </p>

            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link
                href={user ? '/dashboard' : '/auth/login?next=/dashboard'}
                className="rounded-2xl bg-white px-6 py-3 text-sm font-semibold text-black transition hover:-translate-y-0.5 hover:bg-white/90"
              >
                {user ? 'Start my free test' : 'Sign in to continue'}
              </Link>
              <Link href="/" className="rounded-2xl border border-white/15 px-6 py-3 text-sm font-semibold text-white/80 transition hover:border-white/30 hover:bg-white/[0.05] hover:text-white">
                Back to home
              </Link>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
