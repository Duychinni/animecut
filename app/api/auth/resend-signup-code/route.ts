import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string };
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.resend({ type: 'signup', email });
    if (error) {
      const isRateLimited = error.message.toLowerCase().includes('rate limit');
      return NextResponse.json(
        { error: isRateLimited ? 'Please wait 60 seconds before requesting another code.' : 'We could not resend the code. Please try again.' },
        { status: isRateLimited ? 429 : 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to resend the code.' },
      { status: 400 },
    );
  }
}
