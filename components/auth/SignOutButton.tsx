'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Props = {
  className?: string;
};

export function SignOutButton({ className }: Props) {
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);

    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      }).catch(() => null);

      await createClient().auth.signOut({ scope: 'global' }).catch(() => null);
    } finally {
      window.location.assign('/auth/login?msg=Signed%20out');
    }
  }

  return (
    <button
      className={className ?? 'rounded-lg border border-white/25 px-3 py-1.5 text-sm text-white transition hover:border-white/50 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60'}
      type="button"
      disabled={isSigningOut}
      onClick={handleSignOut}
    >
      {isSigningOut ? 'Logging out...' : 'Logout'}
    </button>
  );
}
