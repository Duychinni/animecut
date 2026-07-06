import Stripe from 'stripe';
import { headers } from 'next/headers';
import { getStripe, markProfileCanceled, recordBillingEvent, syncProfileFromSubscription } from '@/lib/billing';

export async function POST(req: Request) {
  const signature = (await headers()).get('stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return new Response('Missing Stripe webhook configuration', { status: 400 });
  }

  const body = await req.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid webhook signature';
    return new Response(message, { status: 400 });
  }

  try {
    await recordBillingEvent(event);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(String(session.subscription), {
            expand: ['items.data.price'],
          });
          await syncProfileFromSubscription(subscription);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        await syncProfileFromSubscription(subscription);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        await markProfileCanceled(subscription);
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
        const subscriptionId = typeof invoice.subscription === 'string'
          ? invoice.subscription
          : invoice.subscription?.id;

        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ['items.data.price'],
          });
          await syncProfileFromSubscription(subscription);
        }
        break;
      }
      case 'invoice.payment_failed':
      case 'customer.subscription.trial_will_end':
      default:
        break;
    }

    return new Response('ok', { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook processing failed';
    return new Response(message, { status: 400 });
  }
}
