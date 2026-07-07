'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BillingInterval, PlanConfig } from '@/lib/plans';
import { readJsonSafe } from '@/lib/safe-json';

export function PricingActions({
  plan,
  interval,
  selected,
  onSelect,
}: {
  plan: PlanConfig;
  interval: BillingInterval;
  selected?: boolean;
  onSelect?: (planId: string) => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selected) onSelect?.(plan.id);
  }, [onSelect, plan.id, selected]);

  async function onClick() {
    if (plan.isSalesOnly) {
      router.push('/contact');
      return;
    }

    try {
      setLoading(true);
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planId: plan.id, interval }),
      });

      const data = await readJsonSafe(res);
      if (!res.ok) {
        if (res.status === 401) {
          router.push(`/auth/login?next=${encodeURIComponent('/pricing')}`);
          return;
        }
        throw new Error(String(data?.error || 'Could not start checkout'));
      }

      if (data?.url) {
        window.location.href = data.url;
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
      disabled={loading}
      className={`mt-3 w-full rounded-2xl px-4 py-3 text-sm font-semibold transition ${
        plan.highlighted ? 'bg-white text-black hover:bg-white/90' : 'border border-white/12 bg-white/[0.03] text-white hover:bg-white/[0.06]'
      } disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {loading ? 'Redirecting...' : plan.cta}
    </button>
  );
}
