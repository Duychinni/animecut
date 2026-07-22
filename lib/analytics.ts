'use client';

import posthog from 'posthog-js';

export type FunnelEvent =
  | 'signup_completed'
  | 'upload_started'
  | 'upload_completed'
  | 'analysis_completed'
  | 'reel_previewed'
  | 'reel_downloaded'
  | 'pricing_viewed'
  | 'subscription_started'
  | 'upload_failed'
  | 'render_failed'
  | 'caption_applied'
  | 'reel_edited'
  | 'plan_upgraded';

export function captureEvent(event: FunnelEvent, properties: Record<string, string | number | boolean | null> = {}) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  posthog.capture(event, properties);
}

export function identifyAnalyticsUser(userId: string) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  posthog.identify(userId);
}
