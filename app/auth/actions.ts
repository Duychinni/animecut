'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

async function resolveAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');

  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') || (host?.includes('localhost') || host?.startsWith('127.0.0.1') ? 'http' : 'https');
  return host ? `${proto}://${host}` : 'http://localhost:3000';
}

export async function login(formData: FormData) {
  const email = String(formData.get('email') || '');
  const password = String(formData.get('password') || '');
  const next = String(formData.get('next') || '/dashboard');

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      redirect(`/auth/login?error=${encodeURIComponent(error.message)}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Login failed';
    redirect(`/auth/login?error=${encodeURIComponent(message)}`);
  }

  redirect(next || '/dashboard');
}

export async function signup(formData: FormData) {
  const email = String(formData.get('email') || '');
  const password = String(formData.get('password') || '');

  try {
    const appUrl = await resolveAppUrl();
    const supabase = await createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${appUrl}/auth/callback?next=${encodeURIComponent('/auth/confirmed')}`,
      },
    });

    if (error) {
      redirect(`/auth/signup?error=${encodeURIComponent(error.message)}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    redirect(`/auth/signup?error=${encodeURIComponent(message)}`);
  }

  redirect(`/auth/check-email?email=${encodeURIComponent(email)}&next=${encodeURIComponent('/dashboard')}`);
}

export async function signout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/auth/login?msg=Signed out');
}
