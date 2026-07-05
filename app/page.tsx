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
    <main className="min-h-screen overflow-hidden bg-[#07070b] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(120,119,255,0.16),transparent_28%),radial-gradient(circle_at_78%_18%,rgba(46,196,182,0.12),transparent_24%),radial-gradient(circle_at_50%_120%,rgba(255,92,92,0.08),transparent_35%)]" />
        <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:54px_54px]" />
        <div className="absolute left-1/2 top-[-10rem] h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-[#7C5CFF]/18 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-6 pb-12 pt-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-4">
          <Link href="/" className="flex items-center gap-3" aria-label="Go to ClipSpark home" prefetch={false}>
            <div className="grid h-9 w-9 place-items-center rounded-2xl border border-white/15 bg-white/[0.07] text-sm font-bold text-white shadow-[0_8px_30px_rgba(0,0,0,0.25)]">
              C
            </div>
            <div>
              <span className="block text-lg font-semibold tracking-tight text-white">ClipSpark</span>
              <span className="block text-[10px] uppercase tracking-[0.28em] text-white/35">Cinematic clip intelligence</span>
            </div>
          </Link>

          <nav className="hidden items-center gap-6 text-sm text-white/70 md:flex">
            <Link href="#how-it-works" className="transition hover:text-white">How it works</Link>
            <Link href="#features" className="transition hover:text-white">Features</Link>
            <Link href="/dashboard" className="transition hover:text-white">Dashboard</Link>
          </nav>

          <div className="flex items-center gap-2">
            {userLabel ? (
              <>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-white/85 backdrop-blur">
                  <span aria-hidden className="text-[#8DF7E8]">✦</span>
                  <span>{tokenBalance.toLocaleString()}</span>
                </div>
                <div className="group relative">
                  {avatarUrl ? (
                    <Image
                      src={avatarUrl}
                      alt={`${userLabel} avatar`}
                      title={userLabel}
                      width={34}
                      height={34}
                      className="h-[34px] w-[34px] rounded-full border border-white/20 object-cover"
                    />
                  ) : (
                    <div
                      title={userLabel}
                      className="grid h-[34px] w-[34px] place-items-center rounded-full border border-white/20 bg-white/10 text-xs font-semibold text-white/85"
                    >
                      {userLabel.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="pointer-events-none absolute -bottom-9 left-1/2 z-20 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-white/20 bg-black/90 px-2 py-1 text-xs text-white/85 group-hover:block">
                    {userLabel}
                  </span>
                </div>
                <a href="/auth/logout" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm transition hover:border-white/35 hover:bg-white/[0.06]">
                  Logout
                </a>
              </>
            ) : (
              <>
                <Link href="/auth/login" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm transition hover:border-white/35 hover:bg-white/[0.06]">
                  Login
                </Link>
                <Link href="/auth/signup" className="rounded-xl bg-white px-3 py-2 text-sm font-medium text-black transition hover:bg-white/90">
                  Create account
                </Link>
              </>
            )}
          </div>
        </header>

        <section className="relative mx-auto mt-14 max-w-7xl">
          <div className="grid items-center gap-12 lg:grid-cols-[1.08fr_0.92fr]">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-white/55 backdrop-blur">
                <span className="inline-block h-2 w-2 rounded-full bg-[#8DF7E8] shadow-[0_0_14px_rgba(141,247,232,0.85)]" />
                Built for cinematic short-form editing
              </div>

              <h1 className="mt-6 text-5xl font-semibold leading-[0.98] tracking-tight text-white md:text-7xl">
                Turn long-form footage into
                <span className="block bg-[linear-gradient(135deg,#ffffff_0%,#9FE8FF_35%,#8B7CFF_70%,#D6D1FF_100%)] bg-clip-text text-transparent">
                  sharp, editorial short clips.
                </span>
              </h1>

              <p className="mt-6 max-w-2xl text-base leading-7 text-white/68 md:text-lg">
                ClipSpark is designed like a dark creative tool, not a generic AI dashboard. Drop in a YouTube link or upload a file,
                and it pulls out the moments that actually feel worth posting.
              </p>

              <div className="mt-8 flex flex-wrap gap-3 text-sm text-white/55">
                <div className="rounded-full border border-white/12 bg-white/[0.03] px-4 py-2">Hook-first scoring</div>
                <div className="rounded-full border border-white/12 bg-white/[0.03] px-4 py-2">Source-aware projects</div>
                <div className="rounded-full border border-white/12 bg-white/[0.03] px-4 py-2">Vertical export ready</div>
              </div>
            </div>

            <div className="relative">
              <div className="absolute -inset-6 rounded-[36px] bg-[radial-gradient(circle_at_top,rgba(124,92,255,0.24),transparent_50%),radial-gradient(circle_at_bottom_right,rgba(141,247,232,0.12),transparent_42%)] blur-2xl" />
              <div className="relative overflow-hidden rounded-[32px] border border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] p-4 shadow-[0_30px_100px_rgba(0,0,0,0.45)] backdrop-blur-xl md:p-5">
                <div className="mb-4 flex items-center justify-between rounded-2xl border border-white/10 bg-black/25 px-4 py-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.22em] text-white/40">Start a new project</p>
                    <p className="mt-1 text-sm text-white/75">Paste a link or upload a source file</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#8DF7E8]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-white/30" />
                    <span className="h-2.5 w-2.5 rounded-full bg-white/18" />
                  </div>
                </div>

                <div className="rounded-[28px] border border-white/12 bg-[#090a10]/90 p-4 md:p-5">
                  <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.02))] p-3">
                    <div className="flex flex-col gap-3 rounded-[20px] border border-white/10 bg-black/25 p-3 md:flex-row md:items-center">
                      <form onSubmit={onAnalyzeLink} className="flex min-w-0 flex-1 flex-col gap-3 md:flex-row md:items-center">
                        <input
                          type="url"
                          name="sourceUrl"
                          placeholder="https://youtube.com/watch?v=..."
                          value={sourceUrl}
                          onChange={(e) => setSourceUrl(e.target.value)}
                          className="h-12 min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.03] px-4 text-sm text-white placeholder:text-white/35 outline-none transition focus:border-[#8B7CFF]/70"
                        />
                        <button
                          type="submit"
                          disabled={!canAnalyzeLink}
                          className="h-12 shrink-0 rounded-2xl bg-[linear-gradient(135deg,#ffffff_0%,#d9e7ff_100%)] px-5 text-sm font-semibold text-black transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {loading ? 'Working...' : 'Get Clips'}
                        </button>
                      </form>

                      <div className="flex items-center gap-3 md:pl-1">
                        <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-white/35">or</span>
                        <label className="grid h-12 shrink-0 cursor-pointer place-items-center rounded-2xl border border-white/16 bg-white/[0.03] px-5 text-sm font-semibold text-white transition hover:border-white/28 hover:bg-white/[0.06]">
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
                    </div>

                    {file ? <p className="mt-3 text-left text-xs text-white/45">Selected: {file.name}</p> : null}
                    {msg ? <p className="mt-3 text-left text-sm text-white/68">{msg}</p> : null}
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    {[
                      ['01', 'Paste any long-form source'],
                      ['02', 'Score scenes for hooks and retention'],
                      ['03', 'Open the best clips in your project board'],
                    ].map(([num, text]) => (
                      <div key={num} className="rounded-2xl border border-white/10 bg-white/[0.025] px-4 py-4">
                        <p className="text-[11px] font-semibold tracking-[0.2em] text-white/35">{num}</p>
                        <p className="mt-2 text-sm leading-6 text-white/72">{text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="mt-20 grid gap-4 md:grid-cols-3">
          {[
            ['Editorial scoring', 'Designed to surface moments with tension, payoff, and clean hooks — not just arbitrary timestamps.'],
            ['Project-native workflow', 'Every source becomes a reusable project with its own title, thumbnail, progress state, and export history.'],
            ['Dark creative surface', 'The interface is shaped more like a premium media tool than a bright, generic AI marketing app.'],
          ].map(([title, desc]) => (
            <article key={title} className="rounded-[24px] border border-white/10 bg-white/[0.03] p-5 text-left backdrop-blur-sm">
              <h3 className="text-base font-semibold text-white">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-white/62">{desc}</p>
            </article>
          ))}
        </section>

        <section id="how-it-works" className="mt-10 rounded-[28px] border border-white/10 bg-white/[0.03] p-6 text-sm text-white/68 backdrop-blur-sm">
          <p className="text-[11px] uppercase tracking-[0.22em] text-white/35">How it works</p>
          <p className="mt-3 max-w-3xl leading-7">
            Add a link or upload a source file, let the system analyze transcript structure and clip potential, then review the strongest results
            inside a dedicated project workspace.
          </p>
        </section>
      </div>
    </main>
  );
}
