'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { readJsonSafe } from '@/lib/safe-json';
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client';

type Mode = 'login' | 'signup';
type OAuthProvider = 'google';

const GOOGLE_AUTH_ENABLED = process.env.NEXT_PUBLIC_ENABLE_GOOGLE_AUTH !== 'false';

function getBrowserSafeOrigin() {
  const url = new URL(window.location.origin);
  if (url.hostname === '0.0.0.0') {
    url.hostname = 'localhost';
  }
  return url.origin;
}

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
  const [localError, setLocalError] = useState<string | null>(error ?? null);
  const [localMsg, setLocalMsg] = useState<string | null>(msg ?? null);

  const isLogin = mode === 'login';

  async function onOAuth(provider: OAuthProvider) {
    if (!GOOGLE_AUTH_ENABLED) {
      setLocalError('This sign-in option is not available yet. Continue with email for now.');
      return;
    }

    setLoading(true);
    setLocalError(null);
    setLocalMsg(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = `${getBrowserSafeOrigin()}/auth/callback?next=${encodeURIComponent(next || '/dashboard')}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });

      if (oauthError) {
        const unsupportedProvider = /unsupported provider|provider is not enabled/i.test(oauthError.message);
        setLocalError(unsupportedProvider ? 'This sign-in option is not available yet. Continue with email for now.' : oauthError.message);
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
        window.location.assign(nextPath);
        return;
      }

      const signupEmail = typeof data?.email === 'string' ? data.email : email;
      router.push(
        `/auth/check-email?email=${encodeURIComponent(signupEmail)}&next=${encodeURIComponent('/')}`,
      );
      router.refresh();
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-[32px] border border-white/12 bg-[#242424]/96 p-8 text-center shadow-[0_30px_90px_rgba(0,0,0,0.42)] backdrop-blur-xl">
      <h1 className="text-[2rem] font-bold tracking-tight text-white">
        {isLogin ? 'Welcome back' : 'Create your account'}
      </h1>
      <p className="mt-3 text-sm text-white/60">
        {isLogin ? 'Continue creating polished clips in minutes.' : 'Start turning long videos into short-form content.'}
      </p>
      {localMsg ? <p className="mt-3 text-sm text-emerald-300">{localMsg}</p> : null}
      {localError ? <p className="mt-3 text-sm text-red-300">{localError}</p> : null}

      {GOOGLE_AUTH_ENABLED ? (
        <>
          <div className="mt-6 space-y-3">
            {GOOGLE_AUTH_ENABLED ? (
              <button
                className="flex w-full items-center justify-center gap-3 rounded-2xl bg-white/[0.08] px-4 py-3 font-semibold text-white transition hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                onClick={() => void onOAuth('google')}
                disabled={loading}
              >
                <GoogleIcon />
                <span>{loading ? 'Working...' : 'Continue with Google'}</span>
              </button>
            ) : null}
          </div>

          <div className="mt-6 flex items-center gap-3 text-sm text-white/38">
            <div className="h-px flex-1 bg-white/10" />
            <span>or continue with email</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>
        </>
      ) : null}

      <form method="post" action="#" onSubmit={onSubmit} className={`${GOOGLE_AUTH_ENABLED ? 'mt-6' : 'mt-8'} space-y-3 text-left`}>
        <input
          className="w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3.5 text-white placeholder:text-white/35 outline-none"
          type="email"
          name="email"
          placeholder="Enter email address"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3.5 text-white placeholder:text-white/35 outline-none"
          type="password"
          name="password"
          placeholder={isLogin ? 'Enter password' : 'Create password'}
          required
          minLength={8}
          autoComplete={isLogin ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input type="hidden" name="next" value={next || '/dashboard'} />
        <button
          className="w-full rounded-2xl bg-white px-4 py-3.5 font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={loading}
        >
          {loading ? 'Working...' : isLogin ? 'Continue with email' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-sm text-white/55">
        {isLogin ? (
          <>
            New here? <Link className="text-white underline underline-offset-4" href={`/auth/signup?next=${encodeURIComponent(next || '/dashboard')}`}>Create account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link className="text-white underline underline-offset-4" href={`/auth/login?next=${encodeURIComponent(next || '/dashboard')}`}>Login here</Link>
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
