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

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const displayName = getDisplayName(user);
  const avatarUrl = getAvatarUrl(user);
  const { data: profile } = user
    ? await supabase
        .from('profiles')
        .select('subscription_plan, processing_minutes_remaining, free_uploads_remaining')
        .eq('id', user.id)
        .maybeSingle()
    : { data: null };
  const subscriptionPlan = profile?.subscription_plan ?? 'free';
  const freeUploadsRemaining = Math.max(0, Number(profile?.free_uploads_remaining ?? 1));
  const processingMinutesRemaining = Math.max(0, Math.floor(Number(profile?.processing_minutes_remaining ?? 0)));
  const allowanceLabel = subscriptionPlan === 'free'
    ? freeUploadsRemaining > 0 ? '1 free test · up to 20 min' : 'Free test used'
    : `${processingMinutesRemaining.toLocaleString()} min left`;
  const showUpgradeNotice = subscriptionPlan === 'free' && freeUploadsRemaining === 0;
  const showLowMinutesNotice = subscriptionPlan !== 'free' && processingMinutesRemaining <= 10;

  return (
    <div className="app-shell min-h-screen text-white">
      <header className="border-b border-white/10 bg-black/20 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <div className="relative flex items-center justify-between gap-4">
            <HomeLogoLink />

            <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center justify-center gap-8 text-base font-medium text-white/90 md:flex">
              <Link href="/#features" className="transition hover:text-white">
                Features
              </Link>
              <Link href="/pricing" className="transition hover:text-white">
                Pricing
              </Link>
              <Link href="/dashboard" className="transition hover:text-white">
                Dashboard
              </Link>
            </nav>

            <div className="flex items-center justify-end gap-2">
              <Link href="/pricing" className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-white/85 transition hover:border-[#ff7bd8]/55 hover:bg-[#ff7bd8]/10 hover:text-white">
                <span aria-hidden className="text-[#ffd84d] drop-shadow-[0_0_10px_rgba(255,216,77,0.85)]">✦</span>
                <span>{allowanceLabel}</span>
              </Link>
              <div className="group relative">
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
              <Link href="/dashboard" className="hidden max-w-28 truncate text-sm font-semibold text-white/80 transition hover:text-white lg:block">
                {displayName}
              </Link>
              <SignOutButton />
            </div>
          </div>

          <div className="mt-5 flex justify-center">
            <ProjectQuickStart compact />
          </div>

          {(showUpgradeNotice || showLowMinutesNotice) ? (
            <div className="mx-auto mt-4 flex max-w-2xl flex-col items-center justify-between gap-3 rounded-2xl border border-[#ff7bd8]/25 bg-[linear-gradient(110deg,rgba(181,109,255,0.12),rgba(255,99,195,0.10),rgba(255,179,71,0.08))] px-4 py-3 text-center shadow-[0_16px_42px_rgba(0,0,0,0.22)] sm:flex-row sm:text-left">
              <div>
                <p className="text-sm font-bold text-white">
                  {showUpgradeNotice ? 'Ready to create more clips?' : 'Your processing minutes are running low.'}
                </p>
                <p className="mt-0.5 text-xs leading-5 text-white/65">
                  {showUpgradeNotice
                    ? 'Subscribe to unlock more video processing minutes and keep creating reels.'
                    : `You have ${processingMinutesRemaining.toLocaleString()} minutes remaining. Add more by upgrading your plan.`}
                </p>
              </div>
              <Link
                href="/pricing"
                className="shrink-0 rounded-xl bg-white px-4 py-2 text-sm font-bold text-black transition hover:-translate-y-0.5 hover:bg-white/90"
              >
                View plans
              </Link>
            </div>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}
