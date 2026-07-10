import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(req: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const res = NextResponse.redirect(new URL('/auth/login?msg=Signed out', req.url));
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
