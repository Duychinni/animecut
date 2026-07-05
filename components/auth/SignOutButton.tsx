import { signout } from '@/app/auth/actions';

export function SignOutButton() {
  return (
    <form action={signout}>
      <button className="rounded-lg border border-white/25 px-3 py-1.5 text-sm text-white transition hover:border-white/50 hover:bg-white/10" type="submit">
        Logout
      </button>
    </form>
  );
}
