import { PostHog } from 'posthog-node';

export type ServerAnalyticsEvent =
  | 'email_signup_created'
  | 'email_verified'
  | 'subscription_started'
  | 'subscription_upgraded'
  | 'subscription_canceled'
  | 'video_render_started'
  | 'video_render_completed'
  | 'video_render_failed';

type AnalyticsProperty = string | number | boolean | null | undefined;

/**
 * Record authoritative lifecycle events from the server. Analytics must never
 * make signup, billing, or rendering fail, so delivery errors are contained.
 */
export async function captureServerEvent(params: {
  distinctId: string;
  event: ServerAnalyticsEvent;
  properties?: Record<string, AnalyticsProperty>;
  eventId?: string;
}) {
  const apiKey = process.env.POSTHOG_API_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey || !params.distinctId) return;

  const client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
  });

  try {
    client.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: {
        ...params.properties,
        ...(params.eventId ? { $insert_id: params.eventId } : {}),
      },
    });
    await client.shutdown();
  } catch (error) {
    console.warn('[analytics] event delivery failed', {
      event: params.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
