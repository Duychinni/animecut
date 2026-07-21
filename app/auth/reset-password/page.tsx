'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(null);
    if (password !== confirmation) { setError('Passwords do not match.'); setLoading(false); return; }
    const { error: updateError } = await createClient().auth.updateUser({ password });
    if (updateError) { setError(updateError.message); setLoading(false); return; }
    router.replace('/dashboard'); router.refresh();
  }

  return <main className="app-shell grid min-h-screen place-items-center px-5 text-white"><form onSubmit={submit} className="w-full max-w-md rounded-[32px] border border-white/12 bg-[#242424]/96 p-8"><h1 className="text-3xl font-bold">Choose a new password</h1><p className="mt-3 text-sm text-white/60">Use at least eight characters.</p>{error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}<input type="password" minLength={8} required autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New password" className="mt-6 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3.5 outline-none"/><input type="password" minLength={8} required autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Confirm new password" className="mt-3 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3.5 outline-none"/><button disabled={loading} className="mt-3 w-full rounded-2xl bg-white px-4 py-3.5 font-semibold text-black disabled:opacity-60">{loading ? 'Updating…' : 'Update password'}</button></form></main>;
}
