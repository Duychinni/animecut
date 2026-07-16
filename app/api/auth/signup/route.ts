import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

function resolveAppUrl(req: Request) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export async function POST(req: Request) {
  try {
    const { email, password } = (await req.json()) as {
      email?: string;
      password?: string;
    };

    const appUrl = resolveAppUrl(req);
    const supabase = await createClient();
    const { error } = await supabase.auth.signUp({
      email: String(email || ''),
      password: String(password || ''),
      options: {
        emailRedirectTo: `${appUrl}/auth/callback?next=${encodeURIComponent('/auth/confirmed')}`,
      },
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      email: String(email || ''),
      msg: 'We sent you a confirmation link. Open it to activate your account.',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
