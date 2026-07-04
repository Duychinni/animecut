import Link from 'next/link';
import { signup } from '@/app/auth/actions';

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const error = params.error;

  return (
    <main className="mx-auto max-w-md p-6 space-y-4">
      <h1 className="text-2xl font-bold">Create account</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <form action={signup} className="space-y-3">
        <input className="w-full border rounded p-2" type="email" name="email" placeholder="Email" required />
        <input className="w-full border rounded p-2" type="password" name="password" placeholder="Password" required minLength={6} />
        <button className="px-4 py-2 rounded bg-black text-white" type="submit">
          Sign up
        </button>
      </form>

      <p className="text-sm text-gray-600">
        Already have an account? <Link className="underline" href="/auth/login">Login</Link>
      </p>
    </main>
  );
}
