import Image from 'next/image';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { ProjectQuickStart } from '@/components/project/ProjectQuickStart';

type ProfileLike = { email?: string | null; user_metadata?: Record<string, unknown> | null };

function getDisplayName(user: ProfileLike | null) {
  if (!user) return '';

  const username =
    (typeof user.user_metadata?.username === 'string' && user.user_metadata.username) ||
    (typeof user.user_metadata?.name === 'string' && user.user_metadata.name) ||
    (typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name) ||
    null;

  if (username) return username;
  if (user.email) return user.email.split('@')[0];
  return 'User';
}

function getAvatarUrl(user: ProfileLike | null) {
  if (!user) return null;

  return (
    (typeof user.user_metadata?.avatar_url === 'string' && user.user_metadata.avatar_url) ||
    (typeof user.user_metadata?.picture === 'string' && user.user_metadata.picture) ||
    null
  );
}

function getTokenBalance(user: ProfileLike | null) {
  if (!user) return 0;

  const raw =
    user.user_metadata?.token_balance ??
    user.user_metadata?.tokens ??
    user.user_metadata?.credits ??
    user.user_metadata?.tokenBalance;

  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }

  return 0;
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const displayName = getDisplayName(user);
  const avatarUrl = getAvatarUrl(user);
  const tokenBalance = getTokenBalance(user);

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <header className="border-b border-white/10 bg-black/20 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-4 px-6 py-3">
          <div className="flex flex-col items-start gap-2 pt-1.5">
            <div className="flex items-center gap-4">
              <HomeLogoLink />
              <Link href="/dashboard" className="text-sm text-white/70 transition hover:text-white">
                Dashboard
              </Link>
            </div>
          </div>
          <ProjectQuickStart compact />
          <div className="flex items-center gap-3 pt-1.5">
            <div className="hidden items-center gap-2 rounded-full border border-white/20 bg-white/5 px-2.5 py-1 text-xs font-semibold text-white/85 md:inline-flex">
              <span aria-hidden className="text-[#FFD54A] drop-shadow-[0_0_8px_rgba(255,213,74,0.75)]">✦</span>
              <span>{tokenBalance.toLocaleString()}</span>
            </div>
            <div className="group relative hidden md:block">
              {avatarUrl ? (
                <Image
                  src={avatarUrl}
                  alt={`${displayName} avatar`}
                  title={displayName}
                  width={32}
                  height={32}
                  className="h-8 w-8 rounded-full border border-white/20 object-cover"
                />
              ) : (
                <div
                  title={displayName}
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/20 bg-white/10 text-xs font-semibold text-white/85"
                >
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
              <span className="pointer-events-none absolute -bottom-9 left-1/2 z-20 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-black/90 px-2 py-1 text-xs text-white/85 group-hover:block">
                {displayName}
              </span>
            </div>
            <SignOutButton />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
