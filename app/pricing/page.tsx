import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { PLAN_CONFIG, type BillingInterval } from '@/lib/plans';
import { PricingCards } from '@/components/billing/PricingCards';
import { createClient } from '@/lib/supabase/server';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { createAdminClient } from '@/lib/supabase/admin';
import { effectivePlanId } from '@/lib/billing';
import type { PlanId } from '@/lib/plans';

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

function getInitials(name: string) {
  return name.charAt(0).toUpperCase();
}

export default async function PricingPage() {
  const interval: BillingInterval = 'monthly';
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const displayName = getDisplayName(user);
  const avatarUrl = getAvatarUrl(user);

  let minuteBalance = 0;
  let currentPlan: PlanId = 'free';
  if (user) {
    try {
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from('profiles')
        .select('processing_minutes_remaining, subscription_plan, subscription_status')
        .eq('id', user.id)
        .maybeSingle();
      minuteBalance = Number(profile?.processing_minutes_remaining ?? 0);
      if (profile) currentPlan = effectivePlanId(profile as { subscription_plan: PlanId; subscription_status: string });
    } catch {
      minuteBalance = 0;
    }
  }

  return (
    <main className="app-shell min-h-screen text-white">
      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="relative flex items-center justify-between border-b border-white/10 pb-4">
          <HomeLogoLink />

          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center justify-center gap-8 text-base font-medium text-white/90 md:flex">
            <Link href="/#feature-showcase" className="transition hover:text-white">Features</Link>
            <Link href="/pricing" className="text-white">Pricing</Link>
            <Link href="/dashboard" className="transition hover:text-white">Dashboard</Link>
          </nav>

          <div className="flex items-center justify-end gap-2">
            {user ? (
              <>
                <div className="hidden items-center gap-2 rounded-full border border-white/20 bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-white/85 lg:inline-flex">
                  <span aria-hidden className="text-[#ffd84d] drop-shadow-[0_0_10px_rgba(255,216,77,0.85)]">&#10022;</span>
                  <span>{minuteBalance.toLocaleString()} min</span>
                </div>
                <Link href="#plans" className="whitespace-nowrap rounded-lg bg-white px-3 py-2 text-xs font-extrabold text-black transition hover:-translate-y-0.5 hover:bg-white/90">
                  <span className="hidden xl:inline">Add more credits</span>
                  <span className="xl:hidden">Add credits</span>
                </Link>
                <div className="group relative">
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatarUrl} alt={`${displayName} avatar`} title={displayName} className="h-8 w-8 rounded-full border border-white/20 object-cover" />
                  ) : (
                    <div title={displayName} className="grid h-8 w-8 place-items-center rounded-full border border-white/20 bg-white/10 text-xs font-semibold text-white/85">
                      {getInitials(displayName)}
                    </div>
                  )}
                  <span className="pointer-events-none absolute -bottom-9 left-1/2 z-20 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-black/90 px-2 py-1 text-xs text-white/85 group-hover:block">
                    {displayName}
                  </span>
                </div>
                <SignOutButton />
              </>
            ) : (
              <Link href="/auth/login?next=/pricing" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">
                Login
              </Link>
            )}
          </div>
        </header>

        <section className="mx-auto mt-14 max-w-5xl text-center">
          <p className="text-sm font-black tracking-[0.24em] text-[#ff7bd8] drop-shadow-[0_0_14px_rgba(255,123,216,0.75)] md:text-base">
            SIMPLE MONTHLY PRICING
          </p>
          <h1 className="mt-4 text-[3rem] font-semibold leading-[1.02] tracking-[-0.03em] md:text-[4.6rem]">
            <span className="block pb-[0.08em] bg-[linear-gradient(135deg,#b56dff_0%,#ff63c3_45%,#ffb347_100%)] bg-clip-text text-transparent">
              Create more. Pay only for what you need.
            </span>
          </h1>

        </section>

        <div id="plans" className="scroll-mt-8">
          <PricingCards plans={PLAN_CONFIG} interval={interval} currentPlan={currentPlan} isAuthenticated={Boolean(user)} />
        </div>

        <section className="mx-auto mt-10 flex max-w-4xl flex-col items-center justify-between gap-4 rounded-3xl border border-white/10 bg-white/[0.03] px-6 py-5 text-center sm:flex-row sm:text-left">
          <div>
            <p className="text-lg font-bold text-white">Need team access or more than 1,500 minutes?</p>
            <p className="mt-1 text-sm text-white/55">Talk with us about a custom plan for agencies and high-volume production.</p>
          </div>
          <Link href="/contact" className="shrink-0 rounded-xl border border-white/15 bg-white/[0.05] px-4 py-2.5 text-sm font-bold text-white transition hover:border-white/30 hover:bg-white/[0.09]">
            Contact us
          </Link>
        </section>
      </div>
    </main>
  );
}
