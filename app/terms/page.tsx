import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

export default function TermsPage() {
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
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">Terms</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight text-white">Terms of Service</h1>
          <div className="mt-6 space-y-6 text-sm leading-7 text-white/70 md:text-base">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Effective July 20, 2026</p>

            <section>
              <h2 className="text-xl font-semibold text-white">Your content and permissions</h2>
              <p className="mt-2">You retain ownership of your content. You represent that you own or have all permissions needed to upload, download, edit, process, and publish it. You grant AnimaCut a limited license to host and process that content only as needed to provide the service. Do not submit unlawful, infringing, private, or harmful content.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">AI-generated results</h2>
              <p className="mt-2">Transcripts, rankings, captions, crops, and suggested clips may be inaccurate or unsuitable. You are responsible for reviewing every result before publication and for complying with platform rules, publicity rights, copyright, and applicable law.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Subscriptions and usage</h2>
              <p className="mt-2">Plans include the processing allowance displayed at purchase. Unless stated otherwise, subscriptions renew automatically until canceled through the billing portal. A standard cancellation takes effect at the end of the current paid billing period; paid access and unused processing minutes remain available until then. At period end, the account returns to the free plan without receiving another free video if its one-time free video was already used. Fees already charged are non-refundable except where required by law or expressly stated in our refund policy. Deleting an account cancels its subscription immediately, permanently removes its stored data, and does not automatically issue a refund. We may prevent abusive usage or attempts to bypass plan limits.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Retention and availability</h2>
              <p className="mt-2">Finished projects are scheduled for deletion three days after completion and abandoned created projects after 24 hours. Download anything you want to keep before that deadline. The service may change, experience interruptions, or produce failed renders; it is not a permanent archive or backup service.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Account termination</h2>
              <p className="mt-2">You may delete your account from Account &amp; privacy. We may suspend or terminate accounts used unlawfully, fraudulently, or in ways that threaten the service or other users.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Questions</h2>
              <p className="mt-2">These terms should be reviewed for your company and jurisdiction before commercial launch. Contact <a className="text-white underline" href="mailto:support@animacut.com">support@animacut.com</a> with questions.</p>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
