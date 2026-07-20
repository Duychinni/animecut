import { NextResponse } from 'next/server';
import { deleteUserProjectsAndArtifacts } from '@/lib/data-deletion';
import { getStripe } from '@/lib/billing';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { confirmation?: string };
    if (body.confirmation !== 'DELETE') {
      return NextResponse.json({ error: 'Type DELETE to confirm account deletion.' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('stripe_subscription_id, subscription_status')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) throw profileError;

    if (profile?.stripe_subscription_id && profile.subscription_status !== 'canceled') {
      // Prevent a deleted account from continuing to renew.
      await getStripe().subscriptions.cancel(profile.stripe_subscription_id);
    }

    const deleted = await deleteUserProjectsAndArtifacts(user.id);

    const { error: usageError } = await admin.from('usage_ledger').delete().eq('user_id', user.id);
    if (usageError && !/does not exist|schema cache/i.test(usageError.message)) throw usageError;

    // Billing event payloads may need to remain for financial records, but the
    // application-level link to the deleted account must be removed.
    const { error: billingError } = await admin.from('billing_events').update({ user_id: null }).eq('user_id', user.id);
    if (billingError && !/does not exist|schema cache/i.test(billingError.message)) throw billingError;

    const { error: authError } = await admin.auth.admin.deleteUser(user.id);
    if (authError) throw authError;

    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not delete account';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
