import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';

const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    disable_session_recording: process.env.NEXT_PUBLIC_POSTHOG_SESSION_REPLAY !== 'true',
    mask_all_text: true,
    mask_all_element_attributes: true,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
