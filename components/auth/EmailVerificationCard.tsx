'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { readJsonSafe } from '@/lib/safe-json';

export function EmailVerificationCard({ email, next = '/' }: { email: string; next?: string }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('Email delivered');

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (!email) {
      setError('Your email address is missing. Return to sign up and try again.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, token: code, next }),
      });
      const data = await readJsonSafe(response);
      if (!response.ok) {
        setError(String(data?.error || 'That verification code is invalid or expired.'));
        return;
      }
      window.location.assign(typeof data?.next === 'string' ? data.next : next);
    } catch (verificationError: unknown) {
      setError(verificationError instanceof Error ? verificationError.message : 'Verification failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    if (!email || cooldown > 0 || resending) return;
    setResending(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/resend-signup-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await readJsonSafe(response);
      if (!response.ok) {
        setError(String(data?.error || 'We could not resend the code yet.'));
        return;
      }
      setMessage('A new code was sent');
      setCooldown(60);
    } catch (resendError: unknown) {
      setError(resendError instanceof Error ? resendError.message : 'We could not resend the code yet.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="w-full rounded-[28px] border border-white/12 bg-[#1c1c20]/95 p-7 text-center shadow-[0_30px_90px_rgba(0,0,0,0.48)] backdrop-blur-xl">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-fuchsia-300/25 bg-fuchsia-400/10 text-2xl">&#9993;</div>
      <h1 className="mt-5 text-2xl font-bold tracking-tight text-white">Enter your verification code</h1>
      <p className="mt-2 text-sm leading-6 text-white/60">
        We sent a six-digit code to<br />
        <strong className="font-semibold text-white">{email || 'your email address'}</strong>
      </p>

      <form onSubmit={verifyCode} className="mt-7 space-y-3 text-left">
        <div className="flex items-center rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3.5 text-sm text-white/65">
          <span className="min-w-0 flex-1 truncate">{email || 'Email address unavailable'}</span>
          <Link href="/auth/signup" className="ml-3 shrink-0 font-semibold text-white transition hover:text-fuchsia-200">Edit</Link>
        </div>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          aria-label="Verification code"
          placeholder="Enter 6-digit verification code"
          className="w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3.5 text-center text-lg font-bold tracking-[0.32em] text-white outline-none transition placeholder:text-left placeholder:text-sm placeholder:font-normal placeholder:tracking-normal placeholder:text-white/35 focus:border-fuchsia-300/45"
        />

        <div className="flex items-center justify-between text-xs">
          <span className="border-b-2 border-emerald-400 pb-1 text-white/55">{message}</span>
          <button
            type="button"
            onClick={() => void resendCode()}
            disabled={cooldown > 0 || resending}
            className="font-semibold text-white transition hover:text-fuchsia-200 disabled:cursor-not-allowed disabled:text-white/35"
          >
            {resending ? 'Sending...' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}
          </button>
        </div>

        {error ? <p role="alert" className="rounded-xl border border-red-300/20 bg-red-400/10 px-3 py-2.5 text-center text-sm text-red-200">{error}</p> : null}

        <button
          type="submit"
          disabled={loading || code.length !== 6}
          className="w-full rounded-2xl bg-white px-4 py-3.5 font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Verifying...' : 'Continue'}
        </button>
      </form>

      <p className="mt-5 text-sm text-white/50">Already verified? <Link href="/auth/login" className="font-semibold text-white underline underline-offset-4">Sign in</Link></p>
      <p className="mt-6 text-xs leading-5 text-white/35">By continuing, you agree to our <Link href="/terms" className="underline">Terms of Service</Link> and <Link href="/privacy" className="underline">Privacy Policy</Link>.</p>
    </div>
  );
}
