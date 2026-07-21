import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getOrCreateProfile, getStripe, resolveAppUrl } from '@/lib/billing';

export async function POST() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const profile = await getOrCreateProfile(user.id);
    if (!profile.stripe_customer_id) {
      return NextResponse.json({ error: 'No Stripe customer found for this account yet' }, { status: 400 });
    }

    const stripe = getStripe();
    const appUrl = await resolveAppUrl();
    const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/dashboard`,
      ...(configuration ? { configuration } : {}),
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not open billing portal';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
