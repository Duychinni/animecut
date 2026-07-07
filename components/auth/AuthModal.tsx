'use client';

import { AuthCard } from '@/components/auth/AuthCard';

export function AuthModal({
  open,
  mode,
  next = '/dashboard',
  onClose,
  onSwitchMode,
}: {
  open: boolean;
  mode: 'login' | 'signup';
  next?: string;
  onClose: () => void;
  onSwitchMode?: (mode: 'login' | 'signup') => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm" onClick={onClose}>
      <div className="relative w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-sm text-white/70 transition hover:bg-white/[0.10] hover:text-white"
        >
          Close
        </button>
        <AuthCard mode={mode} next={next} />
        <div className="mt-4 text-center text-sm text-white/55">
          {mode === 'login' ? (
            <button type="button" className="underline underline-offset-4" onClick={() => onSwitchMode?.('signup')}>
              Need an account? Sign up
            </button>
          ) : (
            <button type="button" className="underline underline-offset-4" onClick={() => onSwitchMode?.('login')}>
              Already have an account? Log in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
