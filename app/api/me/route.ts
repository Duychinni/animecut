import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { effectivePlanId } from '@/lib/billing';

type ProfileLike = {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

function getDisplayName(user: ProfileLike) {
  const username =
    (typeof user.user_metadata?.username === 'string' && user.user_metadata.username) ||
    (typeof user.user_metadata?.name === 'string' && user.user_metadata.name) ||
    (typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name) ||
    null;

  if (username) return username;
  if (user.email) return user.email.split('@')[0];
  return 'User';
}

function getAvatarUrl(user: ProfileLike) {
  return (
    (typeof user.user_metadata?.avatar_url === 'string' && user.user_metadata.avatar_url) ||
    (typeof user.user_metadata?.picture === 'string' && user.user_metadata.picture) ||
    null
  );
}

function getTokenBalance(user: ProfileLike) {
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

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ authenticated: false, user: null });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_plan, subscription_status, processing_minutes_remaining, free_uploads_remaining')
    .eq('id', user.id)
    .maybeSingle();

  const subscriptionPlan = profile
    ? effectivePlanId(profile as Parameters<typeof effectivePlanId>[0])
    : 'free';
  const freeUploadsRemaining = Math.max(0, Number(profile?.free_uploads_remaining ?? 1));
  const processingMinutesRemaining = Math.max(0, Math.floor(Number(profile?.processing_minutes_remaining ?? 0)));
  const allowanceLabel = subscriptionPlan === 'free'
    ? freeUploadsRemaining > 0 ? '1 free video' : 'Free video used'
    : `${processingMinutesRemaining.toLocaleString()} min left`;

  return NextResponse.json({
    authenticated: true,
    user: {
      email: user.email,
      displayName: getDisplayName(user),
      avatarUrl: getAvatarUrl(user),
      tokenBalance: getTokenBalance(user),
      subscriptionPlan,
      processingMinutesRemaining,
      freeUploadsRemaining,
      allowanceLabel,
    },
  });
}
