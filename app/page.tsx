'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type MeResponse = {
  authenticated: boolean;
  user: null | {
    email?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    tokenBalance?: number;
  };
};

function makeProjectTitle() {
  return 'MAIN PROJECTS';
}

export default function Home() {
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<number>(0);

  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        const res = await fetch('/api/me', { credentials: 'include' });
        const data = (await res.json()) as MeResponse;
        if (!isMounted) return;
        if (data?.authenticated && data?.user?.displayName) {
          setUserLabel(data.user.displayName);
          setAvatarUrl(data.user.avatarUrl ?? null);
          setTokenBalance(data.user.tokenBalance ?? 0);
        }
      } catch {
        // best-effort only
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  const canAnalyzeLink = useMemo(() => !loading, [loading]);

  async function createProject(input: { title: string; source_type: 'youtube' | 'upload'; source_url?: string }) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });

    const data = await res.json();
    if (!res.ok) {
      const message = data?.error || 'Failed to create project';
      throw new Error(message);
    }

    return data.project.id as string;
  }

  async function onAnalyzeLink(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceUrl.trim()) {
      setMsg('Paste a YouTube link first, or use Upload files.');
      return;
    }

    try {
      setLoading(true);
      setMsg('Creating project from link...');
      const projectId = await createProject({
        title: makeProjectTitle(),
        source_type: 'youtube',
        source_url: sourceUrl.trim(),
      });

      window.location.href = `/dashboard/projects/${projectId}?autorun=1`;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : 'Could not analyze link';
      if (text.toLowerCase().includes('unauthorized')) {
        setMsg('Please log in first. Redirecting...');
        setTimeout(() => {
          window.location.href = '/auth/login';
        }, 800);
        return;
      }
      setMsg(`Error: ${text}`);
    } finally {
      setLoading(false);
    }
  }

  async function uploadFile(selectedFile: File) {
    try {
      setLoading(true);
      setMsg('Creating upload project...');
      const projectId = await createProject({
        title: makeProjectTitle(),
        source_type: 'upload',
      });

      setMsg('Uploading file...');
      const form = new FormData();
      form.append('project_id', projectId);
      form.append('file', selectedFile);

      const up = await fetch('/api/ingest/upload', { method: 'POST', body: form });
      const upData = await up.json();
      if (!up.ok) {
        throw new Error(upData?.error || 'Upload failed');
      }

      window.location.href = `/dashboard/projects/${projectId}?autorun=1`;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : 'Could not upload file';
      if (text.toLowerCase().includes('unauthorized')) {
        setMsg('Please log in first. Redirecting...');
        setTimeout(() => {
          window.location.href = '/auth/login';
        }, 800);
        return;
      }
      setMsg(`Error: ${text}`);
    } finally {
      setLoading(false);
    }
  }

  async function onUploadFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    if (!selected) return;
    await uploadFile(selected);
    e.target.value = '';
  }

  return (
    <main className="min-h-screen bg-[#07070b] text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(124,92,255,0.16),transparent_28%),radial-gradient(circle_at_82%_16%,rgba(141,247,232,0.10),transparent_24%),radial-gradient(circle_at_50%_120%,rgba(255,255,255,0.03),transparent_35%)]" />
        <div className="absolute inset-0 opacity-[0.05] [background-image:linear-gradient(rgba(255,255,255,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:56px_56px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <Link href="/" className="flex items-center gap-2" aria-label="Go to ClipSpark home" prefetch={false}>
            <div className="grid h-8 w-8 place-items-center rounded-full border border-white/15 bg-white/[0.08] font-bold text-white">C</div>
            <span className="text-lg font-semibold tracking-tight text-white">ClipSpark</span>
          </Link>

          <nav className="hidden items-center gap-6 text-sm text-white/75 md:flex">
            <Link href="#how-it-works" className="transition hover:text-white">How it works</Link>
            <Link href="#features" className="transition hover:text-white">Features</Link>
            <Link href="/dashboard" className="transition hover:text-white">Dashboard</Link>
          </nav>

          <div className="flex items-center gap-2">
            {userLabel ? (
              <>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-white/85">
                  <span aria-hidden className="text-[#8DF7E8] drop-shadow-[0_0_8px_rgba(141,247,232,0.75)]">✦</span>
                  <span>{tokenBalance.toLocaleString()}</span>
                </div>
                <div className="group relative">
                  {avatarUrl ? (
                    <Image
                      src={avatarUrl}
                      alt={`${userLabel} avatar`}
                      title={userLabel}
                      width={32}
                      height={32}
                      className="h-8 w-8 rounded-full border border-white/20 object-cover"
                    />
                  ) : (
                    <div
                      title={userLabel}
                      className="grid h-8 w-8 place-items-center rounded-full border border-white/20 bg-white/10 text-xs font-semibold text-white/85"
                    >
                      {userLabel.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="pointer-events-none absolute -bottom-9 left-1/2 z-20 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-black/90 px-2 py-1 text-xs text-white/85 group-hover:block">
                    {userLabel}
                  </span>
                </div>
                <a href="/auth/logout" className="rounded-lg border border-white/20 px-3 py-2 text-sm transition hover:border-white/40">
                  Logout
                </a>
              </>
            ) : (
              <>
                <Link href="/auth/login" className="rounded-lg border border-white/20 px-3 py-2 text-sm transition hover:border-white/40">
                  Login
                </Link>
                <Link href="/auth/signup" className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-black transition hover:bg-white/90">
                  Create account
                </Link>
              </>
            )}
          </div>
        </header>

        <section className="mx-auto mt-16 max-w-6xl text-center">
          <p className="text-sm font-extrabold tracking-[0.2em] text-[#8DF7E8] drop-shadow-[0_0_12px_rgba(141,247,232,0.6)] md:text-base">#1 AI CLIP TOOL</p>
          <h1 className="mt-4 text-4xl font-bold leading-tight md:text-6xl">
            Turn one long video into multiple
            <span className="block bg-[linear-gradient(135deg,#ffffff_0%,#a9e8ff_40%,#9b8cff_100%)] bg-clip-text text-transparent">
              sharp, viral-ready clips.
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-white/70">
            Paste a link or upload a file to instantly test transcript scoring, hook-first ranking, and short-form clip ideas.
          </p>

          <div className="mx-auto mt-8 w-full max-w-3xl rounded-2xl border border-white/12 bg-white/[0.05] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-sm md:p-5">
            <div className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-2xl border border-white/12 bg-black/30 p-2">
              <form onSubmit={onAnalyzeLink} className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="url"
                  name="sourceUrl"
                  placeholder="https://youtube.com/watch?v=..."
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 text-sm text-white placeholder:text-white/40 outline-none ring-0 focus:border-[#8B7CFF]/60"
                />
                <button
                  type="submit"
                  disabled={!canAnalyzeLink}
                  className="h-11 shrink-0 rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? 'Working...' : 'Get Clips'}
                </button>
              </form>

              <span className="shrink-0 text-xs uppercase tracking-[0.16em] text-white/45">or</span>

              <label className="grid h-11 shrink-0 cursor-pointer place-items-center rounded-xl border border-white/25 px-5 text-sm font-semibold hover:bg-white/10">
                Upload files
                <input
                  type="file"
                  accept="video/*,audio/*"
                  onChange={onUploadFileSelect}
                  className="hidden"
                  disabled={loading}
                />
              </label>
            </div>
            {file ? <p className="mt-2 text-left text-xs text-white/50">Selected: {file.name}</p> : null}
            {msg ? <p className="mt-3 text-left text-sm text-white/70">{msg}</p> : null}
          </div>
        </section>

        <section id="features" className="mt-14 grid gap-4 md:grid-cols-3">
          {[
            ['Hook Score', 'Find strongest openers in the first 5–10 seconds.'],
            ['Auto Clip Ideas', 'Generate structured clips with title + premise + proof points.'],
            ['Export Ready', 'Prep captions and vertical framing for Shorts/TikTok/Reels.'],
          ].map(([title, desc]) => (
            <article key={title} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left backdrop-blur-sm">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-white/65">{desc}</p>
            </article>
          ))}
        </section>

        <section id="how-it-works" className="mb-8 mt-10 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70 backdrop-blur-sm">
          <span className="font-semibold text-white">How it works:</span> 1) Add link or upload file → 2) Run transcript + scoring → 3) Review clips in dashboard.
        </section>
      </div>
    </main>
  );
}
