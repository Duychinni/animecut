'use client';

import { useState } from 'react';
import type { BillingInterval, PlanConfig } from '@/lib/plans';
import { buildPlanFeatures } from '@/lib/plans';
import { PricingActions } from '@/components/billing/PricingActions';

function PlanCard({
  plan,
  interval,
  selected,
  onSelect,
}: {
  plan: PlanConfig;
  interval: BillingInterval;
  selected: boolean;
  onSelect: (planId: string) => void;
}) {
  const showingYearly = interval === 'yearly' && plan.yearlyPrice;
  const price = showingYearly ? plan.yearlyPrice : plan.monthlyPrice;
  const suffix = plan.isSalesOnly ? '' : showingYearly ? '/yr' : '/mo';
  const features = buildPlanFeatures(plan);
  const emphasized = selected;

  return (
    <article
      onClick={() => onSelect(plan.id)}
      className={`flex h-full cursor-pointer flex-col rounded-[28px] border p-6 backdrop-blur-sm transition duration-200 ${
        emphasized
          ? 'scale-[1.02] border-white/30 bg-white/[0.07] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_30px_80px_rgba(0,0,0,0.35)]'
          : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
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

      <PricingActions plan={plan} interval={interval} selected={selected} onSelect={onSelect} />

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

export function PricingCards({ plans, interval }: { plans: PlanConfig[]; interval: BillingInterval }) {
  const [selectedPlanId, setSelectedPlanId] = useState(plans.find((plan) => plan.highlighted)?.id ?? plans[0]?.id ?? '');

  return (
    <section className="mt-14 grid items-stretch gap-6 lg:grid-cols-3">
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          interval={interval}
          selected={selectedPlanId === plan.id}
          onSelect={(planId) => setSelectedPlanId(planId as PlanConfig['id'])}
        />
      ))}
    </section>
  );
}
