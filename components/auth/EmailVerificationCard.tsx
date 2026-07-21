'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { readJsonSafe } from '@/lib/safe-json';

const OTP_EXPIRY_SECONDS = 60 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const OTP_LENGTH = 6;

function formatRemainingTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function EmailVerificationCard({ email, next = '/' }: { email: string; next?: string }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [expiresIn, setExpiresIn] = useState(OTP_EXPIRY_SECONDS);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('Check your inbox');
  const codeInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  function updateCodeDigit(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1);
    const digits = code.padEnd(OTP_LENGTH, ' ').split('');
    digits[index] = digit || ' ';
    setCode(digits.join('').trimEnd());
    if (digit && index < OTP_LENGTH - 1) codeInputRefs.current[index + 1]?.focus();
  }

  function handleCodeKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !code[index] && index > 0) {
      event.preventDefault();
      const digits = code.padEnd(OTP_LENGTH, ' ').split('');
      digits[index - 1] = ' ';
      setCode(digits.join('').trimEnd());
      codeInputRefs.current[index - 1]?.focus();
    }
    if (event.key === 'ArrowLeft' && index > 0) codeInputRefs.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) codeInputRefs.current[index + 1]?.focus();
  }

  function handleCodePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const pastedCode = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pastedCode) return;
    event.preventDefault();
    setCode(pastedCode);
    codeInputRefs.current[Math.min(pastedCode.length, OTP_LENGTH) - 1]?.focus();
  }

  async function pasteCodeFromClipboard() {
    setError(null);
    try {
      const clipboardText = await navigator.clipboard.readText();
      const pastedCode = clipboardText.replace(/\D/g, '').slice(0, OTP_LENGTH);
      if (pastedCode.length !== OTP_LENGTH) {
        setError(`Copy the complete ${OTP_LENGTH}-digit code from your email, then select Paste code.`);
        return;
      }
      setCode(pastedCode);
      codeInputRefs.current[OTP_LENGTH - 1]?.focus();
    } catch {
      setError('Clipboard access was blocked. Paste the code into the first slot instead.');
    }
  }

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    if (expiresIn <= 0) return;
    const timer = window.setInterval(() => setExpiresIn((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [expiresIn]);

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
        setError(String(data?.error || 'That code is invalid or expired. Request a new code and try again.'));
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
        setError(String(data?.error || 'Please wait before requesting another code.'));
        return;
      }
      setCode('');
      setMessage('A new code was sent');
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setExpiresIn(OTP_EXPIRY_SECONDS);
      codeInputRefs.current[0]?.focus();
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
        We sent an {OTP_LENGTH}-digit code to<br />
        <strong className="font-semibold text-white">{email || 'your email address'}</strong>
      </p>

      <form onSubmit={verifyCode} className="mt-7 space-y-3 text-left">
        <div className="flex items-center rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3.5 text-sm text-white/65">
          <span className="min-w-0 flex-1 truncate">{email || 'Email address unavailable'}</span>
          <Link href="/auth/signup" className="ml-3 shrink-0 font-semibold text-white transition hover:text-fuchsia-200">Edit</Link>
        </div>
        <div
          onPaste={handleCodePaste}
          className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-4 sm:gap-3 sm:px-4"
          role="group"
          aria-label={`${OTP_LENGTH}-digit verification code`}
        >
          {Array.from({ length: OTP_LENGTH }, (_, index) => (
            <input
              key={index}
              ref={(element) => { codeInputRefs.current[index] = element; }}
              value={code[index] || ''}
              onChange={(event) => updateCodeDigit(index, event.target.value)}
              onKeyDown={(event) => handleCodeKeyDown(index, event)}
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              pattern="[0-9]"
              maxLength={1}
              required
              autoFocus={index === 0}
              aria-label={`Verification code digit ${index + 1}`}
              className="h-12 w-7 border-x-0 border-t-0 border-b-2 border-white/35 bg-transparent text-center text-2xl font-bold text-white caret-fuchsia-300 outline-none transition focus:border-fuchsia-300 sm:w-10"
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => void pasteCodeFromClipboard()}
          className="w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-xs font-semibold text-white/70 transition hover:border-fuchsia-300/30 hover:text-white"
        >
          Paste code from clipboard
        </button>

        <div className="flex items-center justify-between text-xs">
          <span className="border-b-2 border-emerald-400 pb-1 text-white/55">
            {expiresIn > 0 ? `${message} · valid for ${formatRemainingTime(expiresIn)}` : 'Code expired · request a new code'}
          </span>
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
          disabled={loading || code.length !== OTP_LENGTH || expiresIn <= 0}
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
