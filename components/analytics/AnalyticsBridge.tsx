'use client';

import { useEffect } from 'react';
import { captureEvent, identifyAnalyticsUser, type FunnelEvent } from '@/lib/analytics';

export function AnalyticsIdentity({ userId }: { userId: string }) {
  useEffect(() => { identifyAnalyticsUser(userId); }, [userId]);
  return null;
}

export function AnalyticsEvent({
  event,
  properties = {},
}: {
  event: FunnelEvent;
  properties?: Record<string, string | number | boolean | null>;
}) {
  useEffect(() => { captureEvent(event, properties); }, [event, properties]);
  return null;
}
