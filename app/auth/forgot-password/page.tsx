'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent('/auth/reset-password')}`;
    const { error } = await createClient().auth.resetPasswordForEmail(email, { redirectTo });
    setMessage(error ? error.message : 'If that address has an account, a password-reset link is on its way.');
    setLoading(false);
  }

  return <main className="app-shell grid min-h-screen place-items-center px-5 text-white"><form onSubmit={submit} className="w-full max-w-md rounded-[32px] border border-white/12 bg-[#242424]/96 p-8"><h1 className="text-3xl font-bold">Reset your password</h1><p className="mt-3 text-sm text-white/60">Enter your account email and we’ll send a secure reset link.</p>{message ? <p className="mt-4 text-sm text-emerald-300">{message}</p> : null}<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" className="mt-6 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3.5 outline-none"/><button disabled={loading} className="mt-3 w-full rounded-2xl bg-white px-4 py-3.5 font-semibold text-black disabled:opacity-60">{loading ? 'Sending…' : 'Send reset link'}</button><Link href="/auth/login" className="mt-5 block text-center text-sm text-white/60 underline">Back to login</Link></form></main>;
}
