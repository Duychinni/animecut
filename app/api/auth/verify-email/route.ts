import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

function safeNext(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; token?: string; next?: string };
    const email = String(body.email || '').trim().toLowerCase();
    const token = String(body.token || '').replace(/\D/g, '').slice(0, 8);

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    if (token.length !== 8) {
      return NextResponse.json({ error: 'Enter the complete 8-digit verification code.' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (error || !data.session) {
      const message = error?.message?.toLowerCase() || '';
      const publicError = message.includes('expired') || message.includes('invalid')
        ? 'That code is invalid or expired. Request a new code and use the newest email.'
        : 'We could not verify that code. Check all six digits and try again.';
      return NextResponse.json({ error: publicError }, { status: 400 });
    }

    return NextResponse.json({ ok: true, next: safeNext(body.next) });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Verification failed.' },
      { status: 400 },
    );
  }
}
