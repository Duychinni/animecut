import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { AuthCard } from '@/components/auth/AuthCard';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; msg?: string; next?: string }> }) {
  const params = await searchParams;
  const error = params.error;
  const msg = params.msg;
  const next = params.next ?? '/dashboard';

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <HomeLogoLink />
          <Link href="/auth/signup" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">
            Create account
          </Link>
        </header>

        <section className="mx-auto mt-20 max-w-md">
          <AuthCard mode="login" next={next} error={error} msg={msg} />
        </section>
      </div>
    </main>
  );
}
