import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

export default function ContactPage() {
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
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">Contact</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-white">Get in touch</h1>
          <p className="mt-4 text-sm leading-7 text-white/65 md:text-base">
            For support, partnerships, business inquiries, or product feedback, reach out using the contact details below.
          </p>

          <div className="mt-8 rounded-[24px] border border-white/10 bg-black/20 p-5 text-sm leading-7 text-white/70">
            support@animacut.com
            <br />
            sales@animacut.com
            <br />
            Response time: typically within 1–2 business days.
          </div>
        </section>
      </div>
    </main>
  );
}
