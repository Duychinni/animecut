'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BillingInterval, PlanConfig, PlanId } from '@/lib/plans';

const PLAN_RANK: Record<PlanId, number> = { free: 0, starter: 1, creator: 2, pro: 3, business: 4 };
import { readJsonSafe } from '@/lib/safe-json';

export function PricingActions({
  plan,
  interval,
  selected,
  onSelect,
  currentPlan,
}: {
  plan: PlanConfig;
  interval: BillingInterval;
  selected?: boolean;
  onSelect?: (planId: string) => void;
  currentPlan: PlanId;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const isCurrentPlan = currentPlan === plan.id;
  const isUpgrade = PLAN_RANK[plan.id] > PLAN_RANK[currentPlan] && currentPlan !== 'free';

  useEffect(() => {
    if (selected) onSelect?.(plan.id);
  }, [onSelect, plan.id, selected]);

  async function onClick() {
    try {
      setLoading(true);
      const startBillingRequest = async (confirmUpgrade = false, prorationDate?: number) => {
        const response = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ planId: plan.id, interval, confirmUpgrade, prorationDate }),
        });
        return { response, data: await readJsonSafe(response) };
      };

      let { response: res, data } = await startBillingRequest();
      if (!res.ok) {
        if (res.status === 401) {
          router.push(`/auth/login?next=${encodeURIComponent('/pricing')}`);
          return;
        }
        throw new Error(String(data?.error || 'Could not start checkout'));
      }

      if (data?.requiresUpgradeConfirmation === true) {
        const amountDue = Number(data.amountDue ?? 0);
        const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : 'USD';
        const formattedAmount = new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
        }).format(amountDue / 100);
        const confirmed = window.confirm(
          `Upgrade to ${plan.name}? You are NOT being charged the full ${plan.monthlyPrice} today. Today's prorated charge is ${formattedAmount}. Your next regular renewal will be ${plan.monthlyPrice}.`,
        );
        if (!confirmed) return;

        ({ response: res, data } = await startBillingRequest(true, Number(data.prorationDate)));
        if (!res.ok) throw new Error(String(data?.error || 'Could not complete the upgrade'));
      }

      const checkoutUrl = typeof data?.url === 'string' ? data.url : null;
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
        return;
      }

      throw new Error('Stripe checkout URL missing');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start checkout';
      window.alert(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => {
        onSelect?.(plan.id);
        void onClick();
      }}
      disabled={loading || isCurrentPlan}
      className={`mt-3 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition ${
        selected ? 'bg-white text-black hover:bg-white/90' : 'border border-white/12 bg-white/[0.03] text-white hover:bg-white/[0.06]'
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {loading ? 'Redirecting...' : isCurrentPlan ? 'Current plan' : isUpgrade ? `Upgrade to ${plan.name} — prorated` : plan.cta}
    </button>
  );
}
