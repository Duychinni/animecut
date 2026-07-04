import Link from 'next/link';
import { login } from '@/app/auth/actions';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; msg?: string; next?: string }> }) {
  const params = await searchParams;
  const error = params.error;
  const msg = params.msg;
  const next = params.next ?? '/dashboard';

  return (
    <main className="mx-auto max-w-md p-6 space-y-4">
      <h1 className="text-2xl font-bold">Login</h1>
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <form action={login} className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <input className="w-full border rounded p-2" type="email" name="email" placeholder="Email" required />
        <input className="w-full border rounded p-2" type="password" name="password" placeholder="Password" required />
        <button className="px-4 py-2 rounded bg-black text-white" type="submit">
          Login
        </button>
      </form>

      <p className="text-sm text-gray-600">
        New here? <Link className="underline" href="/auth/signup">Create account</Link>
      </p>
    </main>
  );
}
