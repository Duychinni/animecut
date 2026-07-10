import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

function getSafeRedirectOrigin(requestUrl: URL) {
  const originUrl = new URL(requestUrl.origin);
  if (originUrl.hostname === '0.0.0.0') {
    originUrl.hostname = 'localhost';
  }
  return originUrl.origin;
}

function getSafeNextPath(next: string | null) {
  if (!next || !next.startsWith('/')) return '/dashboard';
  if (next.startsWith('//')) return '/dashboard';
  return next;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const { searchParams } = requestUrl;
  const code = searchParams.get('code');
  const oauthError = searchParams.get('error_description') || searchParams.get('error');
  const next = getSafeNextPath(searchParams.get('next'));
  const safeOrigin = getSafeRedirectOrigin(requestUrl);

  if (oauthError) {
    return NextResponse.redirect(`${safeOrigin}/auth/login?error=${encodeURIComponent(oauthError)}`);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${safeOrigin}/auth/login?error=${encodeURIComponent(error.message)}`);
    }
  }

  return NextResponse.redirect(`${safeOrigin}${next}`);
}
