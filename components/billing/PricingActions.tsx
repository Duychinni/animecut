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
  isAuthenticated,
}: {
  plan: PlanConfig;
  interval: BillingInterval;
  selected?: boolean;
  onSelect?: (planId: string) => void;
  currentPlan: PlanId;
  isAuthenticated: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [upgradeQuote, setUpgradeQuote] = useState<{
    amount: string;
    prorationDate: number;
    paymentMethod: { brand: string; last4: string } | null;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isCurrentPlan = currentPlan === plan.id;
  const isUpgrade = PLAN_RANK[plan.id] > PLAN_RANK[currentPlan] && currentPlan !== 'free';

  useEffect(() => {
    if (selected) onSelect?.(plan.id);
  }, [onSelect, plan.id, selected]);

  async function startBillingRequest(confirmUpgrade = false, prorationDate?: number) {
    const response = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: plan.id, interval, confirmUpgrade, prorationDate }),
    });
    return { response, data: await readJsonSafe(response) };
  }

  async function finishUpgrade(prorationDate: number) {
    try {
      setLoading(true);
      const { response, data } = await startBillingRequest(true, prorationDate);
      if (!response.ok) throw new Error(String(data?.error || 'Could not complete the upgrade'));
      const checkoutUrl = typeof data?.url === 'string' ? data.url : null;
      if (!checkoutUrl) throw new Error('Stripe checkout URL missing');
      window.location.href = checkoutUrl;
    } catch (error) {
      setUpgradeQuote(null);
      setErrorMessage(error instanceof Error ? error.message : 'Could not complete the upgrade');
    } finally {
      setLoading(false);
    }
  }

  async function changePaymentMethod() {
    try {
      setLoading(true);
      setErrorMessage(null);
      const response = await fetch('/api/billing/portal', { method: 'POST' });
      const data = await readJsonSafe(response);
      if (!response.ok) throw new Error(String(data?.error || 'Could not open billing settings'));
      if (typeof data?.url !== 'string') throw new Error('Stripe billing URL missing');
      window.location.href = data.url;
    } catch (error) {
      setUpgradeQuote(null);
      setErrorMessage(error instanceof Error ? error.message : 'Could not open billing settings');
    } finally {
      setLoading(false);
    }
  }

  async function onClick() {
    if (!isAuthenticated) {
      router.push(`/auth/login?next=${encodeURIComponent('/pricing')}`);
      return;
    }

    try {
      setLoading(true);
      setErrorMessage(null);

      const { response: res, data } = await startBillingRequest();
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
        const rawPaymentMethod = data?.paymentMethod;
        const paymentMethod = rawPaymentMethod
          && typeof rawPaymentMethod === 'object'
          && 'brand' in rawPaymentMethod
          && 'last4' in rawPaymentMethod
          && typeof rawPaymentMethod.brand === 'string'
          && typeof rawPaymentMethod.last4 === 'string'
          ? { brand: rawPaymentMethod.brand, last4: rawPaymentMethod.last4 }
          : null;
        setUpgradeQuote({ amount: formattedAmount, prorationDate: Number(data.prorationDate), paymentMethod });
        return;
      }

      const checkoutUrl = typeof data?.url === 'string' ? data.url : null;
      if (checkoutUrl) {
        window.location.href = checkoutUrl;
        return;
      }

      throw new Error('Stripe checkout URL missing');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start checkout';
      setErrorMessage(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
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
      {loading ? 'Redirecting...' : isCurrentPlan ? 'Current plan' : !isAuthenticated ? `Sign in to choose ${plan.name}` : isUpgrade ? `Upgrade to ${plan.name} — prorated` : plan.cta}
    </button>
    {upgradeQuote ? (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby={`upgrade-${plan.id}-title`}>
        <div className="w-full max-w-md rounded-[28px] border border-[#ff7bd8]/30 bg-[#0c0911] p-6 text-left shadow-[0_30px_100px_rgba(0,0,0,0.7)]">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-[#ff7bd8]">Prorated upgrade</p>
          <h3 id={`upgrade-${plan.id}-title`} className="mt-3 text-2xl font-bold text-white">Upgrade to {plan.name}?</h3>
          <p className="mt-3 text-sm leading-6 text-white/65">Unused time on your current plan is credited automatically.</p>
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex justify-between gap-4 text-sm"><span className="text-white/55">Due today</span><strong className="text-white">{upgradeQuote.amount}</strong></div>
            <div className="mt-2 flex justify-between gap-4 text-sm"><span className="text-white/55">Next renewal</span><strong className="text-white">{plan.monthlyPrice}</strong></div>
            <div className="mt-2 flex justify-between gap-4 text-sm"><span className="text-white/55">Payment method</span><strong className="capitalize text-white">{upgradeQuote.paymentMethod ? `${upgradeQuote.paymentMethod.brand} •••• ${upgradeQuote.paymentMethod.last4}` : 'Saved card in Stripe'}</strong></div>
          </div>
          <p className="mt-4 text-xs leading-5 text-white/50">You are not being charged the full {plan.monthlyPrice} today. The prorated amount above will be charged to this payment method.</p>
          <button type="button" onClick={() => void changePaymentMethod()} disabled={loading} className="mt-3 text-xs font-semibold text-[#ff9de2] underline decoration-[#ff9de2]/40 underline-offset-4 hover:text-white disabled:opacity-60">Change payment method in Stripe</button>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <button type="button" onClick={() => setUpgradeQuote(null)} disabled={loading} className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.05]">Cancel</button>
            <button type="button" onClick={() => void finishUpgrade(upgradeQuote.prorationDate)} disabled={loading} className="rounded-xl bg-white px-4 py-3 text-sm font-bold text-black transition hover:bg-white/90 disabled:opacity-60">{loading ? 'Upgrading...' : 'Confirm upgrade'}</button>
          </div>
        </div>
      </div>
    ) : null}
    {errorMessage ? (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-5 backdrop-blur-sm" role="alertdialog" aria-modal="true">
        <div className="w-full max-w-md rounded-[28px] border border-red-300/25 bg-[#0c0911] p-6 text-left">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-red-300">Billing problem</p>
          <h3 className="mt-3 text-xl font-bold text-white">We couldn’t update your plan</h3>
          <p className="mt-3 break-words text-sm leading-6 text-white/65">{errorMessage}</p>
          <button type="button" onClick={() => setErrorMessage(null)} className="mt-6 w-full rounded-xl bg-white px-4 py-3 text-sm font-bold text-black">Close</button>
        </div>
      </div>
    ) : null}
    </>
  );
}
