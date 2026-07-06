import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

export default function PrivacyPage() {
  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-4xl px-6 py-6">
        <header className="grid grid-cols-[auto_1fr_auto] items-center border-b border-white/10 pb-4">
          <HomeLogoLink />
          <nav className="hidden items-center justify-center gap-8 text-base font-medium text-white/90 md:flex">
            <Link href="/#features" className="transition hover:text-white">Features</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
          </nav>
          <Link href="/" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">Back Home</Link>
        </header>

        <section className="mt-16 rounded-[28px] border border-white/10 bg-white/[0.03] p-8 backdrop-blur-sm">
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">Privacy</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-white">Privacy Policy</h1>
          <div className="mt-6 space-y-6 text-sm leading-7 text-white/70 md:text-base">
            <p>AnimaCut collects the account, project, and usage data needed to operate the service and improve reliability.</p>
            <p>Uploaded content and exported clips are processed to deliver the features you use, including transcription, ranking, and rendering.</p>
            <p>We do not sell your personal data. Access to operational data is limited to the systems and providers required to run the platform.</p>
            <p>If you need privacy-related help or deletion requests, contact support directly.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
