import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { AccountMenu } from '@/components/auth/AccountMenu';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { ProjectQuickStart } from '@/components/project/ProjectQuickStart';
import { effectivePlanId } from '@/lib/billing';

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
        .select('subscription_plan, subscription_status, processing_minutes_remaining, free_uploads_remaining')
        .eq('id', user.id)
        .maybeSingle()
    : { data: null };
  const subscriptionPlan = profile
    ? effectivePlanId(profile as Parameters<typeof effectivePlanId>[0])
    : 'free';
  const freeUploadsRemaining = Math.max(0, Number(profile?.free_uploads_remaining ?? 1));
  const processingMinutesRemaining = Math.max(0, Math.floor(Number(profile?.processing_minutes_remaining ?? 0)));
  const allowanceLabel = subscriptionPlan === 'free'
    ? freeUploadsRemaining > 0 ? '1 free video' : 'Free video used'
    : `${processingMinutesRemaining.toLocaleString()} min left`;
  const hasLowMinuteBalance = processingMinutesRemaining <= 20;
  const showUpgradeNotice = subscriptionPlan === 'free' && freeUploadsRemaining === 0 && hasLowMinuteBalance;
  const showLowMinutesNotice = subscriptionPlan !== 'free' && hasLowMinuteBalance;

  return (
    <div className="app-shell min-h-screen text-white">
      <header className="border-b border-white/10 bg-black/20 backdrop-blur">
        <div className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6 sm:py-6">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 md:grid-cols-[auto_minmax(0,1fr)_auto] md:gap-6 lg:gap-10">
            <HomeLogoLink />

            <nav className="hidden min-w-0 items-center justify-center gap-8 justify-self-center text-base font-medium text-white/90 md:flex">
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

            <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end">
              <Link href="/pricing" className="hidden items-center gap-2 whitespace-nowrap rounded-full border border-white/20 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/85 transition hover:border-[#ff7bd8]/55 hover:bg-[#ff7bd8]/10 hover:text-white xl:inline-flex">
                <span aria-hidden className="text-[#ffd84d] drop-shadow-[0_0_10px_rgba(255,216,77,0.85)]">✦</span>
                <span>{allowanceLabel}</span>
              </Link>
              <Link href="/pricing#plans" className="whitespace-nowrap rounded-lg bg-white px-3 py-2 text-xs font-extrabold text-black transition hover:-translate-y-0.5 hover:bg-white/90">
                <span className="hidden xl:inline">Add more credits</span>
                <span className="xl:hidden">Add credits</span>
              </Link>
              <AccountMenu displayName={displayName} avatarUrl={avatarUrl} />
            </div>
          </div>

          <div className="mt-5 flex justify-center">
            <ProjectQuickStart compact />
          </div>

          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm leading-6 text-white/70 md:hidden">
            <p className="font-bold text-white">Mobile-friendly browsing</p>
            <p className="mt-1">Preview reels, check processing, manage billing, and download finished clips here. Uploading and detailed editing work best on a desktop.</p>
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
