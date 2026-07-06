import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { PLAN_CONFIG, type BillingInterval, type PlanConfig, buildPlanFeatures } from '@/lib/plans';
import { PricingActions } from '@/components/billing/PricingActions';
import { createClient } from '@/lib/supabase/server';
import { SignOutButton } from '@/components/auth/SignOutButton';
import { createAdminClient } from '@/lib/supabase/admin';

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

function PlanCard({
  plan,
  interval,
}: {
  plan: PlanConfig;
  interval: BillingInterval;
}) {
  const showingYearly = interval === 'yearly' && plan.yearlyPrice;
  const price = showingYearly ? plan.yearlyPrice : plan.monthlyPrice;
  const suffix = plan.isSalesOnly ? '' : showingYearly ? '/yr' : '/mo';
  const features = buildPlanFeatures(plan);

  return (
    <article
      className={`flex h-full flex-col rounded-[28px] border p-6 backdrop-blur-sm ${
        plan.highlighted
          ? 'border-white/30 bg-white/[0.07] shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_30px_80px_rgba(0,0,0,0.35)]'
          : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-white">{plan.name}</h2>
          <p className="mt-2 text-sm text-white/60">{plan.subtitle}</p>
        </div>
        {showingYearly && plan.yearlyBadge ? (
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
            {plan.yearlyBadge}
          </span>
        ) : null}
      </div>

      <div className="mt-6 flex items-end gap-1">
        <span className="text-5xl font-black tracking-tight text-white">{price}</span>
        {suffix ? <span className="pb-1 text-sm text-white/60">{suffix}</span> : null}
      </div>

      <div className="mt-3 min-h-[64px]">
        {plan.secondaryCta ? <p className="text-sm text-white/58">{plan.secondaryCta}</p> : null}
      </div>

      <PricingActions plan={plan} interval={interval} />

      <ul className="mt-6 space-y-3 text-sm text-white/80">
        {features.map((feature) => (
          <li key={feature} className="flex gap-3">
            <span className="mt-[2px] text-[#ffd84d]">✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ interval?: string }>;
}) {
  const { interval: rawInterval } = await searchParams;
  const interval: BillingInterval = rawInterval === 'yearly' ? 'yearly' : 'monthly';

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const displayName = getDisplayName(user);
  const avatarUrl = getAvatarUrl(user);

  let tokenBalance = 0;
  if (user) {
    try {
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from('profiles')
        .select('processing_minutes_remaining')
        .eq('id', user.id)
        .maybeSingle();
      tokenBalance = Number(profile?.processing_minutes_remaining ?? 0);
    } catch {
      tokenBalance = 0;
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
                <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-white/85">
                  <span aria-hidden className="text-[#ffd84d] drop-shadow-[0_0_10px_rgba(255,216,77,0.85)]">✦</span>
                  <span>{tokenBalance.toLocaleString()}</span>
                </div>
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

        <section className="mx-auto mt-16 max-w-6xl text-center">
          <p className="text-sm font-black tracking-[0.24em] text-[#ff7bd8] drop-shadow-[0_0_14px_rgba(255,123,216,0.75)] md:text-base">
            CHOOSE A PLAN
          </p>
          <h1 className="mt-4 text-[3rem] font-semibold leading-[1.02] tracking-[-0.03em] md:text-[4.8rem]">
            Try one upload free.
            <span className="mt-1 block pb-[0.08em] bg-[linear-gradient(135deg,#b56dff_0%,#ff63c3_45%,#ffb347_100%)] bg-clip-text text-transparent">
              Upgrade when you like the results.
            </span>
          </h1>

          <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm text-white/75 shadow-[0_16px_40px_rgba(0,0,0,0.22)]">
            <Link href="/pricing?interval=monthly" className={`rounded-full px-4 py-2 font-medium transition ${interval === 'monthly' ? 'bg-white text-black shadow-sm' : 'text-white/70 hover:text-white'}`}>
              Monthly
            </Link>
            <Link href="/pricing?interval=yearly" className={`rounded-full px-4 py-2 font-medium transition ${interval === 'yearly' ? 'bg-white text-black shadow-sm' : 'text-white/70 hover:text-white'}`}>
              Yearly
              <span className="ml-2 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                Save 20%
              </span>
            </Link>
          </div>

          <p className="mt-3 text-sm text-white/55">{interval === 'monthly' ? 'Monthly billing selected' : 'Yearly billing selected — save 20%'}</p>
        </section>

        <section className="mt-14 grid items-stretch gap-6 lg:grid-cols-3">
          {PLAN_CONFIG.map((plan) => (
            <PlanCard key={plan.id} plan={plan} interval={interval} />
          ))}
        </section>
      </div>
    </main>
  );
}
