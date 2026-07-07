'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { readJsonSafe } from '@/lib/safe-json';
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client';

type Mode = 'login' | 'signup';

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none">
      <path d="M21.805 12.23c0-.76-.068-1.49-.195-2.192H12v4.15h5.498a4.703 4.703 0 0 1-2.04 3.086v2.563h3.301c1.932-1.78 3.046-4.404 3.046-7.607Z" fill="#4285F4"/>
      <path d="M12 22c2.7 0 4.964-.896 6.618-2.43l-3.301-2.563c-.917.615-2.09.98-3.317.98-2.548 0-4.705-1.72-5.474-4.032H3.113v2.644A9.997 9.997 0 0 0 12 22Z" fill="#34A853"/>
      <path d="M6.526 13.955A5.996 5.996 0 0 1 6.22 12c0-.68.117-1.34.306-1.955V7.4H3.113A9.997 9.997 0 0 0 2 12c0 1.61.385 3.134 1.113 4.6l3.413-2.645Z" fill="#FBBC05"/>
      <path d="M12 6.013c1.468 0 2.787.505 3.826 1.497l2.87-2.87C16.96 3.02 14.696 2 12 2A9.997 9.997 0 0 0 3.113 7.4l3.413 2.645C7.295 7.733 9.452 6.013 12 6.013Z" fill="#EA4335"/>
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-current">
      <path d="M15.22 3.5c0 1.06-.39 2.03-1 2.72-.7.78-1.83 1.37-2.89 1.29-.13-1.02.37-2.1.98-2.78.67-.75 1.84-1.3 2.91-1.23ZM18.4 17.2c-.47 1.08-.7 1.56-1.3 2.53-.83 1.35-2 3.03-3.46 3.05-1.3.03-1.64-.83-3.4-.82-1.76.01-2.13.83-3.43.8-1.45-.03-2.57-1.55-3.4-2.9-2.33-3.77-2.57-8.2-1.14-10.4 1.02-1.57 2.62-2.48 4.12-2.48 1.53 0 2.49.84 3.75.84 1.22 0 1.97-.84 3.74-.84 1.34 0 2.77.73 3.8 2 .16.2.3.4.42.62-3.32 1.82-2.78 6.55.3 7.58Z"/>
    </svg>
  );
}

export function AuthCard({
  mode,
  next = '/dashboard',
  error,
  msg,
}: {
  mode: Mode;
  next?: string;
  error?: string;
  msg?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(mode === 'login');
  const [localError, setLocalError] = useState<string | null>(error ?? null);
  const [localMsg, setLocalMsg] = useState<string | null>(msg ?? null);

  const isLogin = mode === 'login';

  async function onOAuth(provider: 'google' | 'apple') {
    setLoading(true);
    setLocalError(null);
    setLocalMsg(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next || '/dashboard')}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });

      if (oauthError) {
        setLocalError(oauthError.message);
      }
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : `${provider} sign-in failed`);
    } finally {
      setLoading(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setLocalError(null);
    setLocalMsg(null);

    try {
      const res = await fetch(isLogin ? '/api/auth/login' : '/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, next }),
      });

      const data = await readJsonSafe(res);
      if (!res.ok) {
        setLocalError(String(data?.error || 'Request failed'));
        return;
      }

      if (isLogin) {
        const nextPath = typeof data?.next === 'string' ? data.next : (next || '/dashboard');
        router.push(nextPath);
        router.refresh();
        return;
      }

      if (!showPassword) {
        setShowPassword(true);
        setLocalMsg('Now add a password to finish creating your account.');
        return;
      }

      const signupMsg = typeof data?.msg === 'string' ? data.msg : 'Check your email to confirm your account';
      router.push(`/auth/login?msg=${encodeURIComponent(signupMsg)}`);
      router.refresh();
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-[32px] border border-white/10 bg-[#1c1c1c]/95 p-7 text-center shadow-[0_30px_90px_rgba(0,0,0,0.45)] backdrop-blur-xl">
      <h1 className="text-3xl font-bold tracking-tight text-white">
        {isLogin ? 'Welcome back' : 'Finish signing up to get your free clips'}
      </h1>
      <p className="mt-3 text-sm text-white/55">
        {isLogin ? 'Login to keep creating polished clips.' : 'Free plan available. No credit card required.'}
      </p>
      {localMsg ? <p className="mt-3 text-sm text-emerald-300">{localMsg}</p> : null}
      {localError ? <p className="mt-3 text-sm text-red-300">{localError}</p> : null}

      <div className="mt-6 space-y-3">
        <button
          className="flex w-full items-center justify-center gap-3 rounded-2xl bg-white/[0.10] px-4 py-3.5 font-semibold text-white transition hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={() => void onOAuth('google')}
          disabled={loading}
        >
          <GoogleIcon />
          <span>{loading ? 'Working...' : 'Continue with Google'}</span>
        </button>
        <button
          className="flex w-full items-center justify-center gap-3 rounded-2xl bg-white/[0.10] px-4 py-3.5 font-semibold text-white transition hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={() => void onOAuth('apple')}
          disabled={loading}
        >
          <AppleIcon />
          <span>{loading ? 'Working...' : 'Continue with Apple'}</span>
        </button>
      </div>

      <div className="mt-6 flex items-center gap-3 text-sm text-white/40">
        <div className="h-px flex-1 bg-white/10" />
        <span>{isLogin ? 'or continue with email' : 'or continue with email'}</span>
        <div className="h-px flex-1 bg-white/10" />
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-3 text-left">
        <input
          className="w-full rounded-2xl border border-white/12 bg-white/[0.03] px-4 py-3.5 text-white placeholder:text-white/35 outline-none"
          type="email"
          name="email"
          placeholder="Enter email address"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {isLogin || showPassword ? (
          <input
            className="w-full rounded-2xl border border-white/12 bg-white/[0.03] px-4 py-3.5 text-white placeholder:text-white/35 outline-none"
            type="password"
            name="password"
            placeholder="Enter password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : null}
        <button
          className="w-full rounded-2xl bg-white px-4 py-3.5 font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={loading}
        >
          {loading ? 'Working...' : isLogin ? 'Continue with email' : showPassword ? 'Finish sign up' : 'Continue with email'}
        </button>
      </form>

      <p className="mt-5 text-sm text-white/55">
        {isLogin ? (
          <>
            New here? <Link className="text-white underline underline-offset-4" href="/auth/signup">Create account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link className="text-white underline underline-offset-4" href="/auth/login">Login here</Link>
          </>
        )}
      </p>

      <p className="mt-6 text-xs leading-6 text-white/35">
        By continuing, you agree to our <Link className="underline underline-offset-4" href="/terms">Terms of Service</Link>.<br />
        Read our <Link className="underline underline-offset-4" href="/privacy">Privacy Policy</Link>.
      </p>
    </div>
  );
}
