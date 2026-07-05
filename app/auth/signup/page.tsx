import Link from 'next/link';
import { signup } from '@/app/auth/actions';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string; msg?: string; next?: string }> }) {
  const params = await searchParams;
  const error = params.error;
  const msg = params.msg;
  const next = params.next ?? '/dashboard';

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <HomeLogoLink />
          <Link href="/auth/login" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">
            Login
          </Link>
        </header>

        <section className="mx-auto mt-20 max-w-md">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-sm">
            <h1 className="text-3xl font-bold tracking-tight text-white">Create account</h1>
            {msg && <p className="mt-3 text-sm text-emerald-300">{msg}</p>}
            {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

            <form action={signup} className="mt-5 space-y-3">
              <input type="hidden" name="next" value={next} />
              <input className="w-full rounded-xl border border-white/12 bg-white/[0.03] p-3 text-white placeholder:text-white/40 outline-none" type="email" name="email" placeholder="Email" required />
              <input className="w-full rounded-xl border border-white/12 bg-white/[0.03] p-3 text-white placeholder:text-white/40 outline-none" type="password" name="password" placeholder="Password" required />
              <button className="w-full rounded-xl bg-white px-4 py-3 font-semibold text-black transition hover:bg-white/90" type="submit">
                Create account
              </button>
            </form>

            <p className="mt-4 text-sm text-white/60">
              Already have an account? <Link className="text-white underline underline-offset-4" href="/auth/login">Login</Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
