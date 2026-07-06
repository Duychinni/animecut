import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrCreateProfile, getPlanPriceId, getStripe, resolveAppUrl } from '@/lib/billing';
import type { BillingInterval, PlanId } from '@/lib/plans';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { planId?: PlanId; interval?: BillingInterval };
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
    const appUrl = await resolveAppUrl();

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
