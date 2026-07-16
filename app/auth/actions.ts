'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

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
    const supabase = await createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      redirect(`/auth/signup?error=${encodeURIComponent(error.message)}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    redirect(`/auth/signup?error=${encodeURIComponent(message)}`);
  }

  redirect(`/auth/check-email?email=${encodeURIComponent(email)}&next=${encodeURIComponent('/')}`);
}

export async function signout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/auth/login?msg=Signed out');
}
