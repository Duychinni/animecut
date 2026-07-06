'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';

type BillingInterval = 'monthly' | 'yearly';

type Plan = {
  name: string;
  subtitle: string;
  monthlyPrice: string;
  yearlyPrice?: string;
  yearlyBadge?: string;
  highlighted?: boolean;
  features: string[];
  cta: string;
  secondaryCta?: string;
  isSalesOnly?: boolean;
};

const plans: Plan[] = [
  {
    name: 'Starter',
    subtitle: 'For creators testing short-form repurposing',
    monthlyPrice: '$14.99',
    yearlyPrice: '$144',
    yearlyBadge: 'Save 20%',
    features: [
      '1 free upload to test the product first',
      '180 AI Processing Minutes / Month',
      'Maximum upload length: 30 minutes',
      'Maximum generated clips: 15 per upload',
      'HD exports',
      'Premium captions',
      'Speaker detection',
      'No watermark',
    ],
    cta: 'Start Free Trial',
    secondaryCta: 'Then upgrade when you like the results',
  },
  {
    name: 'Pro',
    subtitle: 'For serious creators, marketers, and power users',
    monthlyPrice: '$29.99',
    yearlyPrice: '$288',
    yearlyBadge: 'Save 20%',
    highlighted: true,
    features: [
      '1 free upload before committing',
      '600 AI Processing Minutes / Month',
      'Maximum upload length: 2 hours',
      'Maximum generated clips: 25 per upload',
      'Priority processing',
      'Advanced AI scoring',
      'Caption presets',
      'Priority queue',
    ],
    cta: 'Get Started',
    secondaryCta: 'Best for consistent weekly clip output',
  },
  {
    name: 'Business',
    subtitle: 'For teams, agencies, and high-volume workflows',
    monthlyPrice: 'Custom',
    features: [
      'Custom processing minutes',
      'Custom upload limits',
      'Dedicated infrastructure',
      'API access',
      'Team members',
      'Priority support',
      'Need higher limits? Let’s talk.',
    ],
    cta: 'Contact Sales',
    secondaryCta: 'Need higher limits? Let’s talk.',
    isSalesOnly: true,
  },
];

function PlanCard({
  plan,
  interval,
}: {
  plan: Plan;
  interval: BillingInterval;
}) {
  const showingYearly = interval === 'yearly' && plan.yearlyPrice;
  const price = showingYearly ? plan.yearlyPrice : plan.monthlyPrice;
  const suffix = plan.isSalesOnly ? '' : showingYearly ? '/yr' : '/mo';

  return (
    <article
      className={`flex h-full flex-col rounded-[28px] border p-6 backdrop-blur-sm ${
        plan.highlighted
          ? 'border-white/30 bg-white/[0.07] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_30px_80px_rgba(0,0,0,0.35)]'
          : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-white">{plan.name}</h2>
          <p className="mt-2 text-sm text-white/60">{plan.subtitle}</p>
        </div>
        {showingYearly && plan.yearlyBadge ? (
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
            {plan.yearlyBadge}
          </span>
        ) : null}
      </div>

      <div className="mt-6 flex items-end gap-1">
        <span className="text-5xl font-black tracking-tight text-white">{price}</span>
        {suffix ? <span className="pb-1 text-sm text-white/60">{suffix}</span> : null}
      </div>

      <div className="mt-3 min-h-[44px]">
        {plan.secondaryCta ? <p className="text-sm text-white/58">{plan.secondaryCta}</p> : null}
      </div>

      <button
        type="button"
        className={`mt-3 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition ${
          plan.highlighted ? 'bg-white text-black hover:bg-white/90' : 'border border-white/12 bg-white/[0.03] text-white hover:bg-white/[0.06]'
        }`}
      >
        {plan.cta}
      </button>

      <ul className="mt-6 space-y-3 text-sm text-white/80">
        {plan.features.map((feature) => (
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
  const [interval, setInterval] = useState<BillingInterval>('monthly');

  const toggleLabel = useMemo(
    () =>
      interval === 'monthly'
        ? 'Monthly billing selected'
        : 'Yearly billing selected — save 20%',
    [interval],
  );

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="grid grid-cols-[auto_1fr_auto] items-center border-b border-white/10 pb-4">
          <HomeLogoLink />

          <nav className="hidden items-center justify-center gap-8 text-base font-medium text-white/90 md:flex">
            <Link href="/#features" className="transition hover:text-white">Features</Link>
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
            Try one upload free.
            <span className="mt-1 block pb-[0.08em] bg-[linear-gradient(135deg,#b56dff_0%,#ff63c3_45%,#ffb347_100%)] bg-clip-text text-transparent">
              Upgrade when you like the results.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-3xl text-[15px] leading-7 text-white/70 md:text-base">
            Animacut charges based on uploaded source duration processed — not number of clips. One uploaded minute equals one AI processing minute.
          </p>

          <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm text-white/75 shadow-[0_16px_40px_rgba(0,0,0,0.22)]">
            <button
              type="button"
              onClick={() => setInterval('monthly')}
              className={`rounded-full px-4 py-2 font-medium transition ${
                interval === 'monthly' ? 'bg-white text-black shadow-sm' : 'text-white/70 hover:text-white'
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setInterval('yearly')}
              className={`rounded-full px-4 py-2 font-medium transition ${
                interval === 'yearly' ? 'bg-white text-black shadow-sm' : 'text-white/70 hover:text-white'
              }`}
            >
              Yearly
              <span className="ml-2 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                Save 20%
              </span>
            </button>
          </div>

          <p className="mt-3 text-sm text-white/55">{toggleLabel}</p>

          <div className="mx-auto mt-8 max-w-3xl rounded-[24px] border border-white/10 bg-white/[0.03] p-5 text-left backdrop-blur-sm">
            <p className="text-sm font-semibold text-white">How AI Processing Minutes work</p>
            <p className="mt-2 text-sm leading-6 text-white/65">1 uploaded minute = 1 processing minute. The number of generated clips does not affect usage — only uploaded source duration counts.</p>
            <div className="mt-4 grid gap-3 text-sm text-white/72 md:grid-cols-2">
              <div>• 5-minute video = 5 processing minutes</div>
              <div>• 12-minute video = 12 processing minutes</div>
              <div>• 45-minute podcast = 45 processing minutes</div>
              <div>• 120-minute podcast = 120 processing minutes</div>
            </div>
          </div>

          <div className="mx-auto mt-4 max-w-3xl rounded-[24px] border border-white/10 bg-white/[0.03] p-5 text-left backdrop-blur-sm">
            <p className="text-sm font-semibold text-white">What 180 minutes looks like</p>
            <div className="mt-3 grid gap-3 text-sm text-white/72 md:grid-cols-2">
              <div>• 36 five-minute videos</div>
              <div>• 18 ten-minute videos</div>
              <div>• 6 thirty-minute podcasts</div>
              <div>• 3 one-hour podcasts</div>
            </div>
          </div>
        </section>

        <section className="mt-14 grid gap-6 lg:grid-cols-3 items-stretch">
          {plans.map((plan) => (
            <PlanCard key={plan.name} plan={plan} interval={interval} />
          ))}
        </section>
      </div>
    </main>
  );
}
