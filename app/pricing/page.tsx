'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import {
  PLAN_CONFIG,
  type BillingInterval,
  type PlanConfig,
  buildPlanFeatures,
} from '@/lib/plans';

function PlanCard({
  plan,
  interval,
}: {
  plan: PlanConfig;
  interval: BillingInterval;
}) {
  const showingYearly = interval === 'yearly' && plan.yearlyPrice;
  const price = showingYearly ? plan.yearlyPrice : plan.monthlyPrice;
  const suffix = plan.isSalesOnly ? '' : showingYearly ? '/yr' : '/mo';
  const features = buildPlanFeatures(plan);

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

      <div className="mt-3 min-h-[64px]">
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
        <header className="relative flex items-center justify-between border-b border-white/10 pb-4">
          <HomeLogoLink />

          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center justify-center gap-8 text-base font-medium text-white/90 md:flex">
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

        </section>

        <section className="mt-14 grid items-stretch gap-6 lg:grid-cols-3">
          {PLAN_CONFIG.map((plan) => (
            <PlanCard key={plan.id} plan={plan} interval={interval} />
          ))}
        </section>
      </div>
    </main>
  );
}
