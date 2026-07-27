'use client';

import { useEffect, useState } from 'react';

type State = 'checking' | 'unsupported' | 'blocked' | 'off' | 'on' | 'working' | 'error';

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}
async function getRegistration() {
  return navigator.serviceWorker.register('/push-sw.js');
}

export function BrowserNotifications({ hasProcessingProjects }: { hasProcessingProjects: boolean }) {
  const [state, setState] = useState<State>('checking');

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('blocked');
      return;
    }

    void getRegistration()
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setState(subscription ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, []);

  async function enable() {
    setState('working');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off');
        return;
      }

      const configResponse = await fetch('/api/push/config', { cache: 'no-store' });
      const config = await configResponse.json();
      if (!configResponse.ok || typeof config.publicKey !== 'string') {
        throw new Error(config.error || 'Notifications are unavailable');
      }

      const registration = await getRegistration();
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      });

      const response = await fetch('/api/push/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not save notification preference');
      }
      setState('on');
    } catch {
      setState('error');
    }
  }

  if (state === 'checking' || state === 'unsupported' || (!hasProcessingProjects && state !== 'on')) return null;

  if (state === 'on') {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-sm text-emerald-200">
        <span aria-hidden="true">✓</span>
        <span>We’ll notify this device when your videos are ready.</span>
      </div>
    );
  }

  const blocked = state === 'blocked';
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-xl border border-[#ff7bd8]/20 bg-[#ff7bd8]/[0.055] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-bold text-white">Get notified when your video is ready</p>
        <p className="mt-1 text-xs text-white/55">
          {blocked
            ? 'Notifications are blocked in this browser. Enable them in your site settings to use this feature.'
            : state === 'error'
              ? 'Could not enable notifications. Please try again.'
              : 'You can leave this page—we’ll send a desktop notification when processing finishes.'}
        </p>
      </div>
      {!blocked ? (
        <button
          type="button"
          onClick={() => void enable()}
          disabled={state === 'working'}
          className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-black text-black transition hover:bg-white/90 disabled:opacity-50"
        >
          {state === 'working' ? 'Enabling…' : 'Notify me'}
        </button>
      ) : null}
    </div>
  );
}
