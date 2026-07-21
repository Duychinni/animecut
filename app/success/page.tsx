import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getOrCreateProfile, getStripe, syncProfileFromSubscription } from '@/lib/billing';

export default async function SuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; upgraded?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    try {
      const stripe = getStripe();
      const profile = await getOrCreateProfile(user.id);
      let subscriptionId = profile.stripe_subscription_id;

      if (params.session_id) {
        const checkout = await stripe.checkout.sessions.retrieve(params.session_id);
        if (checkout.metadata?.userId === user.id && checkout.subscription) {
          subscriptionId = typeof checkout.subscription === 'string'
            ? checkout.subscription
            : checkout.subscription.id;
        }
      }

      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['items.data.price'],
        });
        const subscriptionUserId = subscription.metadata.userId;
        if (!subscriptionUserId || subscriptionUserId === user.id) {
          await syncProfileFromSubscription(subscription, { resetAllowance: params.upgraded !== '1' });
        }
      }
    } catch (error) {
      // Webhook processing remains the durable fallback. Do not turn a
      // successful payment into an error page because reconciliation is late.
      console.error('[billing/success] subscription reconciliation failed', error);
    }
  }

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-6 py-16">
        <div className="w-full rounded-[32px] border border-white/10 bg-white/[0.03] p-10 text-center shadow-[0_30px_80px_rgba(0,0,0,0.32)] backdrop-blur-sm">
          <p className="text-6xl">🎉</p>
          <h1 className="mt-5 text-4xl font-bold tracking-tight text-white">Welcome to Animacut.</h1>
          <p className="mt-4 text-base text-white/68">Your subscription is active.</p>
          <p className="mt-2 text-base text-white/68">Start creating clips.</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/dashboard" className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-black transition hover:bg-white/90">
              Open Dashboard
            </Link>
            <Link href="/pricing" className="rounded-2xl border border-white/20 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/35 hover:bg-white/[0.05]">
              Back to Pricing
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
