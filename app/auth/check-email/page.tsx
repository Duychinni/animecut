import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

function maskEmail(value?: string) {
  if (!value || !value.includes('@')) return 'your email address';
  const [name, domain] = value.split('@');
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(3, Math.min(7, name.length - visible.length)))}@${domain}`;
}

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; next?: string }>;
}) {
  const params = await searchParams;
  const next = params.next?.startsWith('/') && !params.next.startsWith('//') ? params.next : '/dashboard';

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <HomeLogoLink />
          <Link
            href={`/auth/login?next=${encodeURIComponent(next)}`}
            className="rounded-xl border border-white/15 bg-white/[0.03] px-4 py-2 text-sm font-semibold text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]"
          >
            Back to sign in
          </Link>
        </header>

        <section className="mx-auto flex min-h-[72vh] max-w-xl items-center justify-center py-16">
          <div className="w-full rounded-[32px] border border-fuchsia-300/20 bg-[#17131c]/95 p-8 text-center shadow-[0_30px_90px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-12">
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-fuchsia-300/25 bg-fuchsia-400/10 text-3xl shadow-[0_0_38px_rgba(232,121,249,0.16)]">
              &#9993;
            </div>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.22em] text-fuchsia-300">Account created</p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Check your inbox to continue</h1>
            <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-white/65 sm:text-base">
              We sent a confirmation link to <strong className="font-semibold text-white">{maskEmail(params.email)}</strong>.
              Open that email and select <strong className="font-semibold text-white">Confirm email address</strong>.
            </p>

            <div className="mx-auto mt-8 max-w-md rounded-2xl border border-white/10 bg-white/[0.035] p-5 text-left">
              <ol className="space-y-4 text-sm text-white/70">
                <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-bold text-white">1</span><span>Open the email from AnimaCut. Check spam or promotions if it is not in your inbox.</span></li>
                <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-bold text-white">2</span><span>Click the confirmation button. The link signs you in securely.</span></li>
                <li className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-bold text-white">3</span><span>You will return to AnimaCut ready to use your free test.</span></li>
              </ol>
            </div>

            <div className="mt-8 rounded-2xl border border-emerald-300/15 bg-emerald-400/[0.06] px-5 py-4 text-sm leading-6 text-emerald-100/80">
              Your account includes one free test project with up to <strong className="text-emerald-100">20 minutes</strong> of source video.
            </div>

            <p className="mt-6 text-xs leading-5 text-white/40">
              You can close this tab after opening the confirmation email. Confirmation links expire for your security.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
