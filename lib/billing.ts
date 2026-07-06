import Stripe from 'stripe';
import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';
import { PLAN_LOOKUP, type BillingInterval, type PlanId } from '@/lib/plans';

export type ProfileRow = {
  id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_plan: PlanId;
  subscription_status: string;
  subscription_interval: BillingInterval | null;
  subscription_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  processing_minutes_limit: number;
  processing_minutes_used: number;
  processing_minutes_remaining: number;
  free_uploads_remaining: number;
};

let cachedStripe: Stripe | null = null;

export function getStripe() {
  if (cachedStripe) return cachedStripe;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('Missing STRIPE_SECRET_KEY');
  }

  cachedStripe = new Stripe(secretKey, {
    apiVersion: '2026-06-24.dahlia',
  });

  return cachedStripe;
}

export async function resolveAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;

  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') || (host?.includes('localhost') || host?.startsWith('127.0.0.1') ? 'http' : 'https');
  return host ? `${proto}://${host}` : 'http://localhost:3000';
}

export async function getOrCreateProfile(userId: string) {
  const admin = createAdminClient();

  const { data: existing, error: existingError } = await admin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing as ProfileRow;

  const { data: created, error: insertError } = await admin
    .from('profiles')
    .insert({ id: userId })
    .select('*')
    .single();

  if (insertError) throw insertError;
  return created as ProfileRow;
}

export function getPlanPriceId(planId: Exclude<PlanId, 'free' | 'business'>, interval: BillingInterval) {
  const envName = `STRIPE_PRICE_${planId.toUpperCase()}_${interval.toUpperCase()}`;
  const priceId = process.env[envName];
  if (!priceId) {
    throw new Error(`Missing ${envName}`);
  }
  return priceId;
}

export function minutesRequiredFromSeconds(totalSeconds: number | null | undefined) {
  if (typeof totalSeconds !== 'number' || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  return Math.ceil(totalSeconds / 60);
}

export async function syncProfileFromSubscription(subscription: Stripe.Subscription) {
  const admin = createAdminClient();
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const planId = (subscription.metadata.planId || 'free') as PlanId;
  const interval = subscription.items.data[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';

  const configuredPlan = planId !== 'free' && planId !== 'business' ? PLAN_LOOKUP[planId] : null;
  const configuredMinutes = planId === 'business' ? null : configuredPlan?.processingMinutes ?? 0;

  const nextLimit = configuredMinutes ?? 0;
  const nextUsed = 0;
  const nextRemaining = nextLimit;

  const { data: profile, error: findError } = await admin
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();

  if (findError) throw findError;
  if (!profile?.id) {
    throw new Error(`No profile found for stripe customer ${customerId}`);
  }

  const { error: updateError } = await admin
    .from('profiles')
    .update({
      stripe_subscription_id: subscription.id,
      subscription_plan: planId,
      subscription_status: subscription.status,
      subscription_interval: interval,
      subscription_ends_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
      current_period_end: new Date(subscription.items.data[0]?.current_period_end ? subscription.items.data[0].current_period_end * 1000 : Date.now()).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
      processing_minutes_limit: nextLimit,
      processing_minutes_used: nextUsed,
      processing_minutes_remaining: nextRemaining,
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id);

  if (updateError) throw updateError;
}

export async function markProfileCanceled(subscription: Stripe.Subscription) {
  const admin = createAdminClient();
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

  const { error } = await admin
    .from('profiles')
    .update({
      stripe_subscription_id: subscription.id,
      subscription_status: subscription.status,
      subscription_ends_at: subscription.ended_at ? new Date(subscription.ended_at * 1000).toISOString() : null,
      current_period_end: subscription.items.data[0]?.current_period_end ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_customer_id', customerId);

  if (error) throw error;
}

export async function recordBillingEvent(event: Stripe.Event) {
  const admin = createAdminClient();
  const customerId = typeof (event.data.object as { customer?: string | Stripe.Customer | Stripe.DeletedCustomer }).customer === 'string'
    ? (event.data.object as { customer?: string }).customer ?? null
    : null;
  const subscriptionId = typeof (event.data.object as { subscription?: string | Stripe.Subscription }).subscription === 'string'
    ? (event.data.object as { subscription?: string }).subscription ?? null
    : 'id' in event.data.object
      ? (event.data.object as { id?: string }).id ?? null
      : null;

  const { data: profile } = customerId
    ? await admin.from('profiles').select('id').eq('stripe_customer_id', customerId).maybeSingle()
    : { data: null };

  await admin.from('billing_events').upsert({
    user_id: profile?.id ?? null,
    stripe_event_id: event.id,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    event_type: event.type,
    payload: event as unknown as Record<string, unknown>,
    processed_at: new Date().toISOString(),
  });
}
