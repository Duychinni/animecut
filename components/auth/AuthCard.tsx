'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { readJsonSafe } from '@/lib/safe-json';

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
  const [localError, setLocalError] = useState<string | null>(error ?? null);
  const [localMsg, setLocalMsg] = useState<string | null>(msg ?? null);

  const isLogin = mode === 'login';

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
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-sm">
      <h1 className="text-3xl font-bold tracking-tight text-white">{isLogin ? 'Login' : 'Create account'}</h1>
      {localMsg ? <p className="mt-3 text-sm text-emerald-300">{localMsg}</p> : null}
      {localError ? <p className="mt-3 text-sm text-red-300">{localError}</p> : null}

      <form onSubmit={onSubmit} className="mt-5 space-y-3">
        <input
          className="w-full rounded-xl border border-white/12 bg-white/[0.03] p-3 text-white placeholder:text-white/40 outline-none"
          type="email"
          name="email"
          placeholder="Email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="w-full rounded-xl border border-white/12 bg-white/[0.03] p-3 text-white placeholder:text-white/40 outline-none"
          type="password"
          name="password"
          placeholder="Password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="w-full rounded-xl bg-white px-4 py-3 font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60" type="submit" disabled={loading}>
          {loading ? 'Working...' : isLogin ? 'Login' : 'Create account'}
        </button>
      </form>

      <p className="mt-4 text-sm text-white/60">
        {isLogin ? (
          <>
            New here? <Link className="text-white underline underline-offset-4" href="/auth/signup">Create account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link className="text-white underline underline-offset-4" href="/auth/login">Login</Link>
          </>
        )}
      </p>
    </div>
  );
}
