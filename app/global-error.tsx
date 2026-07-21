'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { Sentry.captureException(error); }, [error]);
  return (
    <html lang="en">
      <body className="grid min-h-screen place-items-center bg-[#07070b] px-6 text-white">
        <main className="max-w-lg rounded-3xl border border-white/10 bg-white/[0.04] p-8 text-center">
          <h1 className="text-3xl font-bold">Something went wrong</h1>
          <p className="mt-3 text-sm leading-6 text-white/65">Your project is still saved. Try loading this screen again, or contact support if the problem continues.</p>
          <div className="mt-6 flex justify-center gap-3">
            <button onClick={reset} className="rounded-xl bg-white px-4 py-2.5 font-bold text-black">Try again</button>
            <a href="mailto:support@animacut.com" className="rounded-xl border border-white/15 px-4 py-2.5 font-bold text-white">Contact support</a>
          </div>
        </main>
      </body>
    </html>
  );
}
