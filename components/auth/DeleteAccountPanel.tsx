'use client';

import { useState } from 'react';

export function DeleteAccountPanel() {
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function deleteAccount() {
    if (confirmation !== 'DELETE' || deleting) return;
    if (!window.confirm('Permanently delete your account, projects, source videos, and exports? This cannot be undone.')) return;

    setDeleting(true);
    setMessage('Deleting your account and stored media...');
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Account deletion failed');
      window.location.assign('/?account_deleted=1');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Account deletion failed');
      setDeleting(false);
    }
  }

  return (
    <section className="rounded-[24px] border border-red-400/25 bg-red-500/[0.06] p-6">
      <h2 className="text-xl font-semibold text-white">Delete account</h2>
      <p className="mt-3 text-sm leading-6 text-white/65">
        This permanently removes your projects, uploaded sources, generated clips, transcripts, and account. Any active subscription is canceled immediately.
      </p>
      <label className="mt-5 block text-xs font-semibold uppercase tracking-[0.14em] text-white/55" htmlFor="delete-confirmation">Type DELETE to confirm</label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input id="delete-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="h-11 flex-1 rounded-xl border border-white/15 bg-black/30 px-4 text-sm text-white outline-none focus:border-red-300/60" />
        <button type="button" disabled={confirmation !== 'DELETE' || deleting} onClick={() => void deleteAccount()} className="h-11 rounded-xl bg-red-500 px-5 text-sm font-bold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40">
          {deleting ? 'Deleting...' : 'Delete permanently'}
        </button>
      </div>
      {message ? <p className="mt-3 text-sm text-red-200">{message}</p> : null}
    </section>
  );
}
