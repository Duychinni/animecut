'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { readJsonSafe } from '@/lib/safe-json';
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client';

type Mode = 'login' | 'signup';

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
          <span className="text-lg">G</span>
          <span>{loading ? 'Working...' : 'Continue with Google'}</span>
        </button>
        <button
          className="flex w-full items-center justify-center gap-3 rounded-2xl bg-white/[0.10] px-4 py-3.5 font-semibold text-white transition hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={() => void onOAuth('apple')}
          disabled={loading}
        >
          <span className="text-lg"></span>
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
