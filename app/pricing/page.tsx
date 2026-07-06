import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

const starterFeatures = [
  '15 videos per month',
  'Up to 15 AI clips per video',
  'HD exports',
  'Premium captions',
  'Speaker detection',
  'No watermark',
];

const proFeatures = [
  '40 videos per month',
  'Everything in Starter',
  'Priority processing queue',
  'Longer source video support',
  'Advanced clip scoring and ranking',
  'Faster export turnaround',
  'Premium support access',
];

const businessFeatures = [
  'Custom video volume',
  'Everything in Pro',
  'Team workflows',
  'Priority infrastructure allocation',
  'API / custom integrations',
  'Dedicated support',
  'Enterprise onboarding',
];

function PlanCard({
  name,
  subtitle,
  price,
  highlighted = false,
  features,
  cta,
}: {
  name: string;
  subtitle: string;
  price: string;
  highlighted?: boolean;
  features: string[];
  cta: string;
}) {
  return (
    <article
      className={`rounded-[28px] border p-6 backdrop-blur-sm ${
        highlighted
          ? 'border-white/30 bg-white/[0.07] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_30px_80px_rgba(0,0,0,0.35)]'
          : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <h2 className="text-3xl font-bold tracking-tight text-white">{name}</h2>
      <p className="mt-2 text-sm text-white/60">{subtitle}</p>
      <div className="mt-6 flex items-end gap-1">
        <span className="text-5xl font-black tracking-tight text-white">{price}</span>
        <span className="pb-1 text-sm text-white/60">/mo</span>
      </div>

      <button
        type="button"
        className={`mt-6 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition ${
          highlighted ? 'bg-white text-black hover:bg-white/90' : 'border border-white/12 bg-white/[0.03] text-white hover:bg-white/[0.06]'
        }`}
      >
        {cta}
      </button>

      <ul className="mt-6 space-y-3 text-sm text-white/80">
        {features.map((feature) => (
          <li key={feature} className="flex gap-3">
            <span className="mt-[2px] text-[#ffd84d]">✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

export default function PricingPage() {
  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="grid grid-cols-[auto_1fr_auto] items-center border-b border-white/10 pb-4">
          <HomeLogoLink />

          <nav className="hidden items-center justify-center gap-8 text-base font-medium text-white/90 md:flex">
            <Link href="/#features" className="transition hover:text-white">Features</Link>
            <Link href="/#how-it-works" className="transition hover:text-white">How It Works</Link>
            <Link href="/pricing" className="text-white">Pricing</Link>
            <Link href="/dashboard" className="transition hover:text-white">Dashboard</Link>
          </nav>

          <div className="flex items-center justify-end gap-2">
            <Link href="/auth/login" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">
              Login
            </Link>
          </div>
        </header>

        <section className="mx-auto mt-16 max-w-6xl text-center">
          <p className="text-sm font-black tracking-[0.24em] text-[#ff7bd8] drop-shadow-[0_0_14px_rgba(255,123,216,0.75)] md:text-base">
            CHOOSE A PLAN
          </p>
          <h1 className="mt-4 text-[3rem] font-semibold leading-[1.02] tracking-[-0.03em] md:text-[4.8rem]">
            Pick the plan that matches
            <span className="mt-1 block pb-[0.08em] bg-[linear-gradient(135deg,#ffffff_0%,#ff8dde_38%,#d06bff_68%,#ffb347_100%)] bg-clip-text text-transparent">
              your content volume.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-3xl text-[15px] leading-7 text-white/70 md:text-base">
            No confusing credit math. Choose the number of videos you want to turn into shorts each month, then scale when you need more output.
          </p>
        </section>

        <section className="mt-14 grid gap-6 lg:grid-cols-3">
          <PlanCard
            name="Starter"
            subtitle="For creators testing short-form repurposing"
            price="$15"
            features={starterFeatures}
            cta="Choose Starter"
          />

          <PlanCard
            name="Pro"
            subtitle="For serious creators, marketers, and power users"
            price="$29"
            highlighted
            features={proFeatures}
            cta="Choose Pro"
          />

          <PlanCard
            name="Business"
            subtitle="For teams, agencies, and high-volume workflows"
            price="Custom"
            features={businessFeatures}
            cta="Contact Sales"
          />
        </section>
      </div>
    </main>
  );
}
