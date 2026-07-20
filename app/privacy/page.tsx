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
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">Effective July 20, 2026</p>

            <section>
              <h2 className="text-xl font-semibold text-white">Information we process</h2>
              <p className="mt-2">AnimaCut processes account details, subscription and transaction references, product usage, support communications, source links, uploaded audio or video, transcripts, generated clips, thumbnails, and technical logs needed to provide and secure the service.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">How media is used</h2>
              <p className="mt-2">Customer media is used only to provide requested features such as upload, transcription, clip analysis, speaker-aware processing, rendering, playback, and support. AnimaCut does not sell customer media and does not use customer media to train shared or general-purpose AI models.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Service providers</h2>
              <p className="mt-2">We use Supabase for authentication, database services, and private object storage; Cloudflare R2 for private source-media storage; OpenAI for transcription and clip analysis when cloud AI is enabled; Stripe for subscription and payment processing; and hosting or compute providers, including Vercel and our media-processing workers, to operate the application. These providers process data on our behalf under their applicable terms. OpenAI API inputs and outputs are not used for model training by default, but OpenAI may retain abuse-monitoring logs containing customer content for up to 30 days unless stricter data controls apply.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Retention and deletion</h2>
              <p className="mt-2">Finished projects—including uploaded sources, transcripts, generated clips, previews, thumbnails, and related analysis—are scheduled for automatic deletion three days after completion. Incomplete projects that remain in the created state are treated as abandoned and scheduled for deletion after 24 hours. Users may delete projects sooner from the dashboard or permanently delete their account from Account &amp; privacy. Limited billing records may be retained when required for accounting, fraud prevention, dispute resolution, or legal compliance.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Security and access</h2>
              <p className="mt-2">Media buckets are private and application access is provided through time-limited signed URLs. Access is limited to the user who owns the project and systems required to process it. No internet service can guarantee absolute security.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-white">Your choices</h2>
              <p className="mt-2">You can delete individual projects from the dashboard and delete your account from Account &amp; privacy. For access, correction, deletion, or privacy questions, email <a className="text-white underline" href="mailto:support@animacut.com">support@animacut.com</a>.</p>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
