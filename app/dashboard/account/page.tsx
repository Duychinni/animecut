import Link from 'next/link';
import { DeleteAccountPanel } from '@/components/auth/DeleteAccountPanel';

export default function AccountPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href="/dashboard" className="text-sm text-white/60 transition hover:text-white">← Back to dashboard</Link>
      <h1 className="mt-5 text-3xl font-bold text-white">Account and privacy</h1>
      <p className="mt-3 text-sm leading-6 text-white/60">Manage your account data and review how AnimaCut handles stored media.</p>
      <div className="mt-8 space-y-6">
        <section className="grid gap-3 rounded-[24px] border border-white/10 bg-white/[0.03] p-6 text-sm sm:grid-cols-2">
          <Link href="/terms" className="text-white/75 underline underline-offset-4">Terms of Service</Link>
          <Link href="/privacy" className="text-white/75 underline underline-offset-4">Privacy Policy</Link>
          <Link href="/support" className="text-white/75 underline underline-offset-4">Support</Link>
          <Link href="/pricing" className="text-white/75 underline underline-offset-4">Plans and billing</Link>
        </section>
        <section className="rounded-[24px] border border-white/10 bg-white/[0.03] p-6 text-sm leading-6 text-white/65">
          Finished projects and associated media are automatically deleted three days after completion. Abandoned uploads are deleted after 24 hours. You can delete any project sooner from the dashboard.
        </section>
        <DeleteAccountPanel />
      </div>
    </main>
  );
}
