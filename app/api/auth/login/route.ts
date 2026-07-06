import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: Request) {
  try {
    const { email, password, next } = (await req.json()) as {
      email?: string;
      password?: string;
      next?: string;
    };

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: String(email || ''),
      password: String(password || ''),
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, next: next || '/dashboard' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Login failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
