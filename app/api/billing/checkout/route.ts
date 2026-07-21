import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrCreateProfile, getPlanPriceId, getStripe, hasPaidSubscriptionAccess, syncProfileFromSubscription } from '@/lib/billing';
import type { BillingInterval, PlanId } from '@/lib/plans';

const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  creator: 2,
  pro: 3,
  business: 4,
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { planId?: PlanId; interval?: BillingInterval; confirmUpgrade?: boolean; prorationDate?: number };
    const planId = body.planId;
    const interval = body.interval;

    if (!planId || !interval) {
      return NextResponse.json({ error: 'Missing planId or interval' }, { status: 400 });
    }

    if (planId === 'business' || planId === 'free') {
      return NextResponse.json({ error: 'This plan does not use self-serve checkout' }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const profile = await getOrCreateProfile(user.id);
    const stripe = getStripe();
    // Billing is also exercised from Vercel Preview deployments. Supabase auth
    // cookies are scoped to the host where the user signed in, so returning a
    // Preview checkout to the production APP_URL makes that authenticated user
    // appear signed out. Always return this interactive flow to its initiating
    // origin instead.
    const appUrl = new URL(req.url).origin;

    let customerId = profile.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: user.id,
        },
      });
      customerId = customer.id;

      const admin = (await import('@/lib/supabase/admin')).createAdminClient();
      await admin.from('profiles').update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() }).eq('id', user.id);
    }

    if (hasPaidSubscriptionAccess(profile)) {
      if (profile.subscription_plan === planId) {
        return NextResponse.json({ error: `You are already subscribed to ${planId}.` }, { status: 400 });
      }
      if (PLAN_RANK[planId] < PLAN_RANK[profile.subscription_plan]) {
        return NextResponse.json({ error: 'Use Manage billing to schedule a downgrade.' }, { status: 400 });
      }

      const activeSubscriptions = profile.stripe_subscription_id
        ? null
        : await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
      const subscriptionId = profile.stripe_subscription_id
        ?? activeSubscriptions?.data.find((subscription) => ['active', 'trialing', 'past_due'].includes(subscription.status))?.id;
      if (!subscriptionId) {
        return NextResponse.json({ error: 'Could not find the active subscription to upgrade.' }, { status: 400 });
      }

      const currentSubscription = await stripe.subscriptions.retrieve(subscriptionId);
      const subscriptionItem = currentSubscription.items.data[0];
      if (!subscriptionItem) {
        return NextResponse.json({ error: 'The active subscription has no billable plan item.' }, { status: 400 });
      }

      const nextPriceId = getPlanPriceId(planId, interval);
      if (body.confirmUpgrade !== true) {
        const prorationDate = Math.floor(Date.now() / 1000);
        const preview = await stripe.invoices.createPreview({
          customer: customerId,
          subscription: subscriptionId,
          subscription_details: {
            items: [{ id: subscriptionItem.id, price: nextPriceId, quantity: 1 }],
            billing_cycle_anchor: 'unchanged',
            proration_behavior: 'always_invoice',
            proration_date: prorationDate,
          },
        });
        const prorationLines = preview.lines.data.filter((line) => (
          line.parent?.subscription_item_details?.proration === true
          || line.parent?.invoice_item_details?.proration === true
        ));
        const amountDue = prorationLines.reduce((total, line) => (
          total + line.amount + (line.taxes ?? []).reduce((taxTotal, tax) => taxTotal + tax.amount, 0)
        ), 0);

        return NextResponse.json({
          requiresUpgradeConfirmation: true,
          amountDue: Math.max(0, amountDue),
          currency: preview.currency,
          prorationDate,
          currentPlan: profile.subscription_plan,
          nextPlan: planId,
        });
      }

      const prorationDate = Number(body.prorationDate);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isInteger(prorationDate) || prorationDate > now || now - prorationDate > 15 * 60) {
        return NextResponse.json({ error: 'The upgrade quote expired. Please review the latest prorated amount.' }, { status: 409 });
      }

      const upgradedSubscription = await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: subscriptionItem.id, price: nextPriceId, quantity: 1 }],
        proration_behavior: 'always_invoice',
        proration_date: prorationDate,
        payment_behavior: 'pending_if_incomplete',
        metadata: {
          ...currentSubscription.metadata,
          userId: user.id,
          planId,
          interval,
        },
        expand: ['latest_invoice'],
      });

      const latestInvoice = typeof upgradedSubscription.latest_invoice === 'string'
        ? null
        : upgradedSubscription.latest_invoice;
      const paymentUrl = latestInvoice?.status === 'open' && 'hosted_invoice_url' in latestInvoice
        ? latestInvoice.hosted_invoice_url
        : null;

      // Do not make the browser wait for a webhook before its upgraded plan
      // and allowance appear. Stripe pending updates retain the old price when
      // payment has not completed, so only synchronize once the requested
      // price is actually active on the subscription.
      const activePriceId = upgradedSubscription.items.data[0]?.price.id;
      if (activePriceId === nextPriceId && ['active', 'trialing', 'past_due'].includes(upgradedSubscription.status)) {
        await syncProfileFromSubscription(upgradedSubscription, { resetAllowance: false });
      }

      return NextResponse.json({
        url: paymentUrl || `${appUrl}/success?upgraded=1`,
        upgraded: true,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [
        {
          price: getPlanPriceId(planId, interval),
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      success_url: `${appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/pricing`,
      billing_address_collection: 'auto',
      metadata: {
        userId: user.id,
        planId,
        interval,
      },
      subscription_data: {
        metadata: {
          userId: user.id,
          planId,
          interval,
        },
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not start checkout';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
