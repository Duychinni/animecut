import Link from 'next/link';
import { EmailVerificationCard } from '@/components/auth/EmailVerificationCard';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; next?: string }>;
}) {
  const params = await searchParams;
  const email = String(params.email || '').trim().toLowerCase();
  const next = params.next?.startsWith('/') && !params.next.startsWith('//') ? params.next : '/';

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <HomeLogoLink />
          <Link
            href="/auth/login"
            className="rounded-xl border border-white/15 bg-white/[0.03] px-4 py-2 text-sm font-semibold text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]"
          >
            Back to sign in
          </Link>
        </header>

        <section className="mx-auto flex min-h-[72vh] max-w-md items-center justify-center py-12">
          <EmailVerificationCard email={email} next={next} />
        </section>
      </div>
    </main>
  );
}
