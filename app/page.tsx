'use client';

import Image from 'next/image';
import Link from 'next/link';
import { DemoShowcase } from '@/components/home/DemoShowcase';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { useEffect, useState } from 'react';

type MeResponse = {
  authenticated: boolean;
  user: null | {
    email?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    tokenBalance?: number;
  };
};

const templatePresets = [
  '🔥 Viral Clips',
  '🎙 Podcast',
  '📈 Educational',
  '😂 Comedy',
  '🎮 Gaming',
  '💼 Business',
  '💰 Finance',
  '🥊 MMA',
];

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

      await fetch(`/api/projects/${projectId}/start`, { method: 'POST' }).catch(() => null);
      window.location.href = `/dashboard`;
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

      await fetch(`/api/projects/${projectId}/start`, { method: 'POST' }).catch(() => null);
      window.location.href = `/dashboard`;
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
    <main className="min-h-screen bg-[#05050a] text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_12%_22%,rgba(175,78,255,0.14),transparent_26%),radial-gradient(circle_at_80%_24%,rgba(255,83,196,0.10),transparent_24%),radial-gradient(circle_at_92%_38%,rgba(255,170,64,0.07),transparent_18%),radial-gradient(circle_at_50%_120%,rgba(255,255,255,0.025),transparent_36%)]" />
        <div className="absolute inset-0 opacity-[0.022] [background-image:linear-gradient(rgba(255,255,255,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.12)_1px,transparent_1px)] [background-size:56px_56px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-6 py-6">
        <header className="grid grid-cols-[260px_1fr_260px] items-center border-b border-white/10 pb-4">
          <HomeLogoLink />

          <nav className="hidden items-center justify-center gap-8 text-base font-medium text-white/90 md:flex">
            <Link href="#features" className="transition hover:text-white">Features</Link>
            <Link href="#how-it-works" className="transition hover:text-white">How It Works</Link>
            <Link href="#faq" className="transition hover:text-white">FAQ</Link>
            <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
            <Link href="/dashboard" className="transition hover:text-white">Dashboard</Link>
          </nav>

          <div className="flex items-center justify-end gap-2">
            {userLabel ? (
              <>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-white/85">
                  <span aria-hidden className="text-[#ffd84d] drop-shadow-[0_0_10px_rgba(255,216,77,0.85)]">✦</span>
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
              <Link href="/auth/login" className="rounded-xl border border-white/15 bg-white/[0.03] px-3 py-2 text-sm text-white/85 transition hover:border-white/30 hover:bg-white/[0.06]">
                Login
              </Link>
            )}
          </div>
        </header>

        <section className="mx-auto mt-16 max-w-6xl text-center">
          <p className="text-sm font-black tracking-[0.24em] text-[#ff7bd8] drop-shadow-[0_0_14px_rgba(255,123,216,0.75)] md:text-base">#1 AI CLIP TOOL</p>
          <h1 className="mt-4 text-[3.25rem] font-semibold leading-[1.02] tracking-[-0.03em] md:text-[5.25rem]">
            Upload once.
            <span className="mt-1 block pb-[0.08em] bg-[linear-gradient(135deg,#ffffff_0%,#ff8dde_38%,#d06bff_68%,#ffb347_100%)] bg-clip-text text-transparent">
              Get weeks of content.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-4xl text-[15px] leading-7 text-white/70 md:text-base">
            Ready in minutes. Paste a link or upload a file and turn one long video into polished shorts for TikTok, Reels, and YouTube Shorts.
          </p>

          <div className="mx-auto mt-8 w-full max-w-3xl">
            <div className="mb-4 grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 mx-auto">
              {templatePresets.map((preset) => (
                <span key={preset} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-center text-xs font-semibold text-white/80">
                  {preset}
                </span>
              ))}
            </div>

            <div className="mx-auto flex w-full max-w-3xl items-center gap-2 rounded-2xl border border-white/12 bg-black/25 p-2 shadow-[0_16px_40px_rgba(0,0,0,0.22)]">
              <form onSubmit={onAnalyzeLink} className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="url"
                  name="sourceUrl"
                  placeholder="Drop a video link"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 text-sm text-white placeholder:text-white/40 outline-none ring-0 focus:border-[#8B7CFF]/60"
                />
                <button
                  type="submit"
                  disabled={loading}
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

            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm text-white/70">
              <span>⭐⭐⭐⭐⭐ Trusted by 2,000+ creators</span>
              <span className="hidden h-1 w-1 rounded-full bg-white/25 md:inline-block" />
              <span>Over 1,000 hours of video clipped</span>
            </div>

            {file ? <p className="mt-2 text-left text-xs text-white/50">Selected: {file.name}</p> : null}
            {msg ? <p className="mt-3 text-left text-sm text-white/70">{msg}</p> : null}
          </div>
        </section>

        <section id="features" className="mt-16 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm md:p-8">
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">Before vs After</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white md:text-4xl">One podcast episode becomes weeks of posts.</h2>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {[
                { title: '45 minute podcast', desc: 'One long-form source video.' },
                { title: '12 AI-picked shorts', desc: 'Best hooks, reactions, and standout moments.' },
                { title: 'Ready to post', desc: 'Vertical exports with captions and polished framing.' },
              ].map((item, index) => (
                <div key={item.title} className="rounded-[24px] border border-white/10 bg-black/20 p-5">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-white/35">0{index + 1}</p>
                  <h3 className="mt-3 text-lg font-semibold text-white">{item.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-white/60">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm md:p-8">
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">Supported platforms</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white md:text-4xl">Works with the content you already make.</h2>
            <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
              {['▶️ YouTube', '🎵 TikTok', '📸 Instagram', '📘 Facebook', '🎙 Podcast', '📁 MP4 Upload'].map((platform) => (
                <div key={platform} className="rounded-[22px] border border-white/10 bg-black/20 px-4 py-5 text-center text-sm font-semibold text-white/80">
                  {platform}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-16">
          <DemoShowcase />
        </section>

        <section id="how-it-works" className="mt-16 rounded-[28px] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm md:p-8">
          <div className="max-w-3xl">
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">How it works</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white md:text-4xl">From long video to ready-to-post clips.</h2>
            <p className="mt-4 text-sm leading-7 text-white/65 md:text-base">
              AnimaCut handles the full short-form workflow for you — from ingesting the source to finding the strongest moments and exporting polished clips.
            </p>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[
              {
                step: '01',
                title: 'Add your source',
                desc: 'Paste a YouTube link or upload a file to create a project instantly.',
              },
              {
                step: '02',
                title: 'AI analyzes the content',
                desc: 'The app transcribes the video, scores moments, and ranks the best potential clips.',
              },
              {
                step: '03',
                title: 'Smart framing + captions',
                desc: 'Exports are rendered vertically with captions, high-quality thumbnails, and smart reframing.',
              },
              {
                step: '04',
                title: 'Review and download',
                desc: 'Open your finished project, compare top clips, and download the ones worth posting.',
              },
            ].map((item) => (
              <div key={item.step} className="rounded-[24px] border border-white/10 bg-black/20 p-5">
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-white/35">{item.step}</p>
                <h3 className="mt-3 text-lg font-semibold text-white">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-white/60">{item.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="faq" className="mt-16 rounded-[28px] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm md:p-8">
          <div className="max-w-3xl">
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">FAQ</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white md:text-4xl">Questions creators ask before they upload.</h2>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {[
              ['How long can videos be?', 'Longer uploads work best on higher plans, and the app is built for podcasts, interviews, and long-form content.'],
              ['How many clips are generated?', 'Clip count depends on source length, but AnimaCut targets multiple strong shorts from every video.'],
              ['Do I keep ownership?', 'Yes. Your source content stays yours, and the exported clips are yours to publish.'],
              ['Can I upload YouTube links?', 'Yes — you can paste YouTube links directly or upload your own MP4 files.'],
              ['Can I upload podcasts?', 'Yes. Podcast episodes are one of the best use cases for generating multiple shorts.'],
              ['Can I edit captions?', 'Yes. You can re-render clips with different caption presets and styles.'],
              ['Can I cancel anytime?', 'Yes. Plans are simple and can be changed as your usage grows.'],
              ['Does it support multiple platforms?', 'Yes. The output is built for TikTok, Reels, Shorts, and other vertical video channels.'],
            ].map(([question, answer]) => (
              <div key={question} className="rounded-[24px] border border-white/10 bg-black/20 p-5">
                <h3 className="text-lg font-semibold text-white">{question}</h3>
                <p className="mt-3 text-sm leading-6 text-white/60">{answer}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="mt-16 border-t border-white/10 py-8 text-sm text-white/60">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <p className="text-white/75">AnimaCut — upload once, get weeks of content.</p>
            <div className="flex flex-wrap items-center gap-4">
              <Link href="#features" className="transition hover:text-white">Features</Link>
              <Link href="#how-it-works" className="transition hover:text-white">How It Works</Link>
              <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
              <a href="#faq" className="transition hover:text-white">Support</a>
              <a href="#" className="transition hover:text-white">Terms</a>
              <a href="#" className="transition hover:text-white">Privacy</a>
              <a href="#" className="transition hover:text-white">Contact</a>
              <a href="#" className="transition hover:text-white">Discord</a>
              <a href="#" className="transition hover:text-white">Twitter</a>
              <a href="#" className="transition hover:text-white">LinkedIn</a>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}
