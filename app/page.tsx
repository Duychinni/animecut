'use client';

import Image from 'next/image';
import Link from 'next/link';
import { HomeLogoLink } from '@/components/nav/HomeLogoLink';
import { AuthModal } from '@/components/auth/AuthModal';
import { uploadFileMultipartToR2 } from '@/lib/browser-upload';
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

type ShowcaseClip = {
  title: string;
  score: number;
  caption: string;
  platform: 'YouTube' | 'TikTok' | 'Instagram' | 'Podcast' | 'Facebook';
  length: string;
  source: string;
  gradient: string;
};

const templatePresets = [
  '🔥 Viral Clips',
  '🎙 Podcast',
  '📈 Educational',
  '😂 Comedy',
  '🎮 Gaming',
  '💼 Business',
  '💰 Finance',
];

const showcaseClips: ShowcaseClip[] = [
  {
    title: 'He explains why most creators quit too early',
    score: 96,
    caption: 'The real edge is consistency after the first boring stretch.',
    platform: 'TikTok',
    length: '00:31',
    source: 'Joe Rogan Experience',
    gradient: 'from-[#3a1838] via-[#1b1522] to-[#0a0a10]',
  },
  {
    title: 'Theo turns one story into a perfect hook clip',
    score: 92,
    caption: 'That one line is exactly the kind of opening that stops the scroll.',
    platform: 'Instagram',
    length: '00:28',
    source: 'This Past Weekend with Theo Von',
    gradient: 'from-[#40203b] via-[#1c1424] to-[#09090f]',
  },
  {
    title: 'Lex asks the question that changes the whole conversation',
    score: 94,
    caption: 'Strong clips often come from one clean question followed by a pause.',
    platform: 'YouTube',
    length: '00:43',
    source: 'Lex Fridman Podcast',
    gradient: 'from-[#241d42] via-[#141528] to-[#09090f]',
  },
  {
    title: 'Diary of a CEO moment with instant repost potential',
    score: 89,
    caption: 'People share clips that make them feel understood in one sentence.',
    platform: 'Facebook',
    length: '00:36',
    source: 'Diary of a CEO',
    gradient: 'from-[#3c2030] via-[#1b1622] to-[#09090f]',
  },
  {
    title: 'Huberman segment that lands as a clean educational short',
    score: 91,
    caption: 'Specific insight + simple framing = very strong educational clip.',
    platform: 'Podcast',
    length: '00:45',
    source: 'Huberman Lab',
    gradient: 'from-[#252d46] via-[#151928] to-[#09090f]',
  },
  {
    title: 'All-In hot take trimmed into a strong vertical cut',
    score: 87,
    caption: 'The disagreement is the hook — the edit just brings it forward.',
    platform: 'TikTok',
    length: '00:24',
    source: 'All-In Podcast',
    gradient: 'from-[#43211b] via-[#20141a] to-[#09090f]',
  },
  {
    title: 'Shawn Ryan story beat with high retention energy',
    score: 95,
    caption: 'Narrative tension makes for great clips when the punchline is preserved.',
    platform: 'YouTube',
    length: '00:39',
    source: 'Shawn Ryan Show',
    gradient: 'from-[#2b283f] via-[#161726] to-[#09090f]',
  },
  {
    title: 'Nate Diaz reaction clip that feels instantly native',
    score: 90,
    caption: 'The cadence and facial beat make this feel made for short-form.',
    platform: 'Instagram',
    length: '00:22',
    source: 'Nate Diaz Podcast',
    gradient: 'from-[#3a1b24] via-[#1d131c] to-[#09090f]',
  },
  {
    title: 'Joe Rogan back-and-forth edited into a perfect opener',
    score: 93,
    caption: 'Two lines, one reaction, instant curiosity gap.',
    platform: 'TikTok',
    length: '00:26',
    source: 'Joe Rogan Experience',
    gradient: 'from-[#421f39] via-[#1f1524] to-[#09090f]',
  },
  {
    title: 'Theo Von punchline isolated into a short viral beat',
    score: 88,
    caption: 'Comedy clips work when the setup is tight and the payoff lands fast.',
    platform: 'Facebook',
    length: '00:19',
    source: 'This Past Weekend with Theo Von',
    gradient: 'from-[#312144] via-[#191628] to-[#09090f]',
  },
  {
    title: 'Lex Fridman insight repackaged for thoughtful viewers',
    score: 90,
    caption: 'The strongest intellectual clips still need a plain-language opener.',
    platform: 'Podcast',
    length: '00:47',
    source: 'Lex Fridman Podcast',
    gradient: 'from-[#243149] via-[#16192a] to-[#09090f]',
  },
  {
    title: 'Huberman takeaway trimmed into a clean branded export',
    score: 86,
    caption: 'This one feels polished because the frame and captions do less.',
    platform: 'Instagram',
    length: '00:33',
    source: 'Huberman Lab',
    gradient: 'from-[#432a2a] via-[#1c1520] to-[#09090f]',
  },
];

function makeProjectTitle() {
  return 'MAIN PROJECTS';
}

function getPlatformTone(platform: ShowcaseClip['platform']) {
  switch (platform) {
    case 'TikTok':
      return 'text-white';
    case 'Instagram':
      return 'text-[#ff95dc]';
    case 'YouTube':
      return 'text-[#ff5f7f]';
    case 'Facebook':
      return 'text-[#87a8ff]';
    case 'Podcast':
      return 'text-[#f3c57a]';
    default:
      return 'text-white/80';
  }
}

function getPlatformBadge(platform: ShowcaseClip['platform']) {
  switch (platform) {
    case 'TikTok':
      return 'bg-white/[0.08] text-white border-white/10';
    case 'Instagram':
      return 'bg-[#ff7bd8]/10 text-[#ffb1ea] border-[#ff7bd8]/25';
    case 'YouTube':
      return 'bg-[#ff5f7f]/10 text-[#ff9cae] border-[#ff5f7f]/25';
    case 'Facebook':
      return 'bg-[#87a8ff]/10 text-[#b6c8ff] border-[#87a8ff]/25';
    case 'Podcast':
      return 'bg-[#f3c57a]/10 text-[#ffdca9] border-[#f3c57a]/25';
    default:
      return 'bg-white/[0.08] text-white border-white/10';
  }
}

export default function Home() {
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const [selectedClip, setSelectedClip] = useState<ShowcaseClip | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('signup');

  const carouselItems = useMemo(() => [...showcaseClips, ...showcaseClips, ...showcaseClips, ...showcaseClips], []);

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

    if (data?.devBypass) {
      setMsg('Development billing bypass is active — this local test will not use your real upload/minute allowance.');
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
        setMsg('Please log in first.');
        setAuthMode('signup');
        setAuthModalOpen(true);
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
      setUploadProgress(0);
      setMsg('Creating upload project...');
      const cleanedTitle = selectedFile.name.replace(/\.[^/.]+$/, '');
      const projectId = await createProject({
        title: cleanedTitle || makeProjectTitle(),
        source_type: 'upload',
      });

      setMsg('Preparing direct upload...');
      const prep = await fetch('/api/ingest/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          filename: selectedFile.name,
          contentType: selectedFile.type || 'application/octet-stream',
          size: selectedFile.size,
        }),
      });
      const prepData = await prep.json();
      if (!prep.ok) {
        throw new Error(prepData?.error || 'Could not prepare upload');
      }

      if (prepData.provider === 'r2-multipart') {
        setMsg('Uploading file in parts to R2 storage...');
        await uploadFileMultipartToR2(selectedFile, prepData, setUploadProgress);
      } else {
        setMsg('Uploading file directly to storage...');
        const uploadRes = await fetch(prepData.uploadUrl, {
          method: prepData.method || 'PUT',
          headers: prepData.headers || {
            'content-type': selectedFile.type || 'application/octet-stream',
          },
          body: selectedFile,
        });

        if (!uploadRes.ok) {
          const errText = await uploadRes.text().catch(() => 'Upload failed');
          throw new Error(errText || 'Upload failed');
        }

        setUploadProgress(100);
      }
      setMsg('Upload complete. Starting processing...');
      await fetch(`/api/projects/${projectId}/start`, { method: 'POST' }).catch(() => null);
      window.location.href = `/dashboard`;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : 'Could not upload file';
      if (text.toLowerCase().includes('unauthorized')) {
        setMsg('Please log in first.');
        setAuthMode('signup');
        setAuthModalOpen(true);
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
    <main className="min-h-screen overflow-x-hidden bg-[#05050a] text-white">
      <style jsx global>{`
        @keyframes floatSlow {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(0, -14px, 0); }
        }
        @keyframes driftOrb {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(10px, -8px, 0) scale(1.03); }
        }
        @keyframes marqueeLeft {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(-25%, 0, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .hero-marquee {
            animation: none !important;
            transform: translate3d(0, 0, 0) !important;
          }
        }
        @keyframes glowSweep {
          0% { transform: translateX(-10%); opacity: .45; }
          50% { opacity: .85; }
          100% { transform: translateX(10%); opacity: .45; }
        }
      `}</style>

      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-14 h-[22rem] w-[22rem] rounded-full bg-[#8a4dff]/14 blur-[110px]" style={{ animation: 'driftOrb 28s ease-in-out infinite' }} />
        <div className="absolute right-[-6rem] top-[18rem] h-[26rem] w-[26rem] rounded-full bg-[#ff52c4]/10 blur-[120px]" style={{ animation: 'driftOrb 34s ease-in-out infinite reverse' }} />
        <div className="absolute bottom-[-8rem] left-[20%] h-[24rem] w-[24rem] rounded-full bg-[#ffb347]/8 blur-[120px]" style={{ animation: 'driftOrb 40s ease-in-out infinite' }} />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_12%_22%,rgba(175,78,255,0.12),transparent_26%),radial-gradient(circle_at_80%_24%,rgba(255,83,196,0.08),transparent_24%),radial-gradient(circle_at_92%_38%,rgba(255,170,64,0.06),transparent_18%),radial-gradient(circle_at_50%_120%,rgba(255,255,255,0.02),transparent_36%)]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-6 py-6">
        <header className="grid grid-cols-[260px_1fr_260px] items-center border-b border-white/10 pb-4">
          <HomeLogoLink />

          <nav className="hidden items-center justify-center gap-8 text-[16px] font-medium text-white/90 md:flex">
            <Link href="#feature-showcase" className="transition hover:text-white">Features</Link>
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

        <section className="relative py-16 lg:py-24">
          <div className="mx-auto max-w-4xl text-center">
            <p className="text-sm font-black tracking-[0.24em] text-[#ff7bd8] drop-shadow-[0_0_14px_rgba(255,123,216,0.75)] md:text-base">#1 AI VIDEO CLIPPING TOOL</p>
            <h1 className="mt-4 text-[3.25rem] font-extrabold leading-[1.02] tracking-[-0.03em] md:text-[5.25rem]">
              Upload once.
              <span className="mt-1 block pb-[0.08em] bg-[linear-gradient(135deg,#b56dff_0%,#ff63c3_45%,#ffb347_100%)] bg-clip-text text-transparent drop-shadow-[0_0_24px_rgba(214,107,255,0.16)]">
                Get weeks of content.
              </span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-[15px] leading-7 text-white/70 md:text-base">
              Ready in minutes. Paste a link or upload a file and turn one long video into polished shorts for TikTok, Reels, and YouTube Shorts.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
              {templatePresets.map((preset) => (
                <span key={preset} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-center text-xs font-semibold text-white/80 whitespace-nowrap transition hover:border-[#8B7CFF]/30 hover:bg-white/[0.06] hover:text-white">
                  {preset}
                </span>
              ))}
            </div>

            <div className="mx-auto mt-8 w-full max-w-3xl rounded-[28px] border border-white/12 bg-black/25 p-2 shadow-[0_16px_40px_rgba(0,0,0,0.22)] backdrop-blur-xl">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <form onSubmit={onAnalyzeLink} className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="url"
                    name="sourceUrl"
                    placeholder="Drop a video link"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    className="h-12 min-w-0 flex-1 rounded-2xl border border-white/10 bg-white/[0.03] px-4 text-sm text-white placeholder:text-white/40 outline-none ring-0 transition focus:border-[#8B7CFF]/60 focus:shadow-[0_0_0_1px_rgba(139,124,255,0.25),0_0_30px_rgba(139,124,255,0.16)]"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="h-12 shrink-0 rounded-2xl bg-white px-5 text-sm font-semibold text-black transition duration-200 hover:-translate-y-0.5 hover:bg-white/90 hover:shadow-[0_12px_30px_rgba(255,255,255,0.12)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loading ? 'Working...' : 'Get Clips'}
                  </button>
                </form>

                <div className="flex items-center gap-2 lg:shrink-0">
                  <span className="shrink-0 px-1 text-xs uppercase tracking-[0.16em] text-white/45">or</span>
                  <label className="grid h-12 flex-1 cursor-pointer place-items-center rounded-2xl border border-white/25 px-5 text-sm font-semibold transition duration-200 hover:-translate-y-0.5 hover:border-white/35 hover:bg-white/10 hover:shadow-[0_12px_30px_rgba(139,124,255,0.12)] lg:flex-none">
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
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm text-white/90">
              <span>⭐⭐⭐⭐⭐ Trusted by 2,000+ creators</span>
              <span className="hidden h-1 w-1 rounded-full bg-white/25 md:inline-block" />
              <span>Over 1,000 hours of video clipped</span>
            </div>

            {file ? <p className="mt-2 text-xs text-white/50">Selected: {file.name}</p> : null}
            {loading ? (
              <div className="mx-auto mt-3 w-full max-w-xl">
                <div className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[linear-gradient(90deg,#8B7CFF,#FF7BD8,#FFB347)] transition-all duration-300" style={{ width: `${Math.max(uploadProgress, msg.includes('Uploading') ? 65 : msg.includes('Preparing') ? 20 : msg.includes('Starting') ? 90 : 8)}%` }} />
                </div>
              </div>
            ) : null}
            {msg ? <p className="mt-3 text-sm text-white/70">{msg}</p> : null}
          </div>
        </section>

        <section id="demo" className="relative left-1/2 mt-8 w-screen -translate-x-1/2 py-10">
          <div className="mx-auto mb-6 max-w-7xl px-6 text-center">
            <h2 className="text-2xl font-bold tracking-tight text-white md:text-3xl">Real examples of what Animacut can turn long-form into.</h2>
          </div>

          <div className="overflow-hidden">
            <div className="hero-marquee flex w-max flex-nowrap gap-4 px-4 [will-change:transform]" style={{ animation: 'marqueeLeft 88s linear infinite' }}>
              {carouselItems.map((clip, index) => (
                <div
                  key={`${clip.title}-${index}`}
                  className="w-[248px] shrink-0 rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] p-3 text-left shadow-[0_18px_50px_rgba(0,0,0,0.26)]"
                >
                  <div className={`aspect-[9/16] rounded-[20px] border border-white/10 bg-gradient-to-b ${clip.gradient} p-2.5`}>
                    <div className="flex h-full flex-col justify-start rounded-[16px] border border-white/8 bg-black/18 p-2.5 backdrop-blur">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-full border border-[#ff7bd8]/30 bg-[#ff7bd8]/10 px-2 py-1 text-[11px] font-semibold text-[#ffb1ea]">🔥 {clip.score}</span>
                        <span className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${getPlatformBadge(clip.platform)} ${getPlatformTone(clip.platform)}`}>
                          {clip.platform}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3">
                    <h3 className="text-[13px] font-semibold leading-4.5 text-white">{clip.title}</h3>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="feature-showcase" className="relative left-1/2 w-screen -translate-x-1/2 pt-6 pb-2">
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 py-10 lg:grid-cols-[1.08fr_0.92fr]">
            <div className="relative order-2 lg:order-1">
              <div className="absolute -left-8 top-10 h-36 w-36 rounded-full bg-[#8b7cff]/16 blur-3xl" />
              <div className="relative rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] p-4 shadow-[0_32px_90px_rgba(0,0,0,0.34)]">
                <div className="rounded-[28px] border border-white/10 bg-[#090912] p-4">
                  <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ff6b7a]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ffd15e]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#4ade80]" />
                    <span className="ml-3 text-xs uppercase tracking-[0.18em] text-white/35">dashboard preview</span>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
                    <div className="space-y-4">
                      <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4" style={{ animation: 'floatSlow 7s ease-in-out infinite' }}>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">AI scoring</p>
                        <p className="mt-2 text-3xl font-semibold text-white">94</p>
                        <p className="mt-2 text-sm text-white/55">High hook retention + clarity.</p>
                      </div>
                      <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4" style={{ animation: 'floatSlow 8s ease-in-out infinite' }}>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Caption presets</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {['Bold Glow', 'Subtle Clean', 'Punchy Creator'].map((preset) => (
                            <span key={preset} className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-white/75">{preset}</span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[26px] border border-white/10 bg-[linear-gradient(180deg,rgba(139,124,255,0.08),rgba(255,255,255,0.03))] p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Clip library</p>
                          <p className="mt-1 text-lg font-semibold text-white">Your top candidates</p>
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-white/55">12 items</span>
                      </div>
                      <div className="mt-4 space-y-3">
                        {[
                          ['Opener with strongest hold', '94', 'Ready'],
                          ['Counterintuitive hot take', '91', 'Queued'],
                          ['Story payoff moment', '88', 'Exported'],
                        ].map(([title, score, state]) => (
                          <div key={title} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/75">
                            <span>{title}</span>
                            <span className="rounded-full border border-[#ff7bd8]/30 bg-[#ff7bd8]/10 px-2 py-1 text-xs font-semibold text-[#ffb1ea]">{score}</span>
                            <span className="text-xs text-white/45">{state}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="order-1 lg:order-2">
              <div className="space-y-4">
                {[
                  ['AI scoring', 'Show confidence, hook quality, and clip ranking as part of the interface.'],
                  ['Caption presets', 'Preview different caption treatments without leaving the workflow.'],
                  ['Clip library', 'Compare winners fast with scores, lengths, and export status.'],
                  ['Dashboard', 'Make the dashboard itself look like the hero product asset.'],
                ].map(([title, desc]) => (
                  <div key={title} className="rounded-[24px] border border-white/10 bg-white/[0.03] px-5 py-4 transition duration-300 hover:-translate-y-1 hover:border-[#8b7cff]/35 hover:shadow-[0_18px_50px_rgba(139,124,255,0.12)]">
                    <h3 className="text-lg font-semibold text-white">{title}</h3>
                    <p className="mt-2 text-sm leading-6 text-white/58">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="mt-8 rounded-[30px] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm md:p-8">
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
              <div key={question} className="rounded-[24px] border border-white/10 bg-black/20 p-5 transition duration-300 hover:-translate-y-1 hover:border-[#8b7cff]/35 hover:shadow-[0_18px_50px_rgba(139,124,255,0.12)]">
                <h3 className="text-lg font-semibold text-white">{question}</h3>
                <p className="mt-3 text-sm leading-6 text-white/60">{answer}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.025))] px-6 py-10 shadow-[0_28px_80px_rgba(0,0,0,0.28)] backdrop-blur-xl md:px-10 md:py-12">
          <div className="grid items-center gap-8 lg:grid-cols-[1fr_auto]">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-white md:text-5xl">Start with one upload. Scale when the clips start working.</h2>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-white/65 md:text-base">
                Keep this section clear and conversion-focused. By the time people reach pricing, the product should already feel obvious, credible, and desirable.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/pricing" className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-black transition duration-200 hover:-translate-y-0.5 hover:bg-white/90 hover:shadow-[0_12px_30px_rgba(255,255,255,0.12)]">
                See Pricing
              </Link>
              <Link href="/dashboard" className="rounded-2xl border border-white/20 px-5 py-3 text-sm font-semibold text-white transition duration-200 hover:-translate-y-0.5 hover:border-white/35 hover:bg-white/[0.05] hover:shadow-[0_12px_30px_rgba(139,124,255,0.12)]">
                Open Dashboard
              </Link>
            </div>
          </div>
        </section>

        <footer className="mt-16 border-t border-white/10 py-8 text-sm text-white/60">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <p className="text-white/75">AnimaCut — upload once, get weeks of content.</p>
            <div className="flex flex-wrap items-center gap-4">
              <Link href="#demo" className="transition hover:text-white">Demo</Link>
              <Link href="#feature-showcase" className="transition hover:text-white">Features</Link>
              <Link href="/pricing" className="transition hover:text-white">Pricing</Link>
              <Link href="/support" className="transition hover:text-white">Support</Link>
              <Link href="/terms" className="transition hover:text-white">Terms</Link>
              <Link href="/privacy" className="transition hover:text-white">Privacy</Link>
              <Link href="/contact" className="transition hover:text-white">Contact</Link>
            </div>
          </div>
        </footer>
      </div>

      <AuthModal
        open={authModalOpen}
        mode={authMode}
        next="/dashboard"
        onClose={() => setAuthModalOpen(false)}
        onSwitchMode={(mode) => setAuthMode(mode)}
      />

      {selectedClip ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm" onClick={() => setSelectedClip(null)}>
          <div
            className="w-full max-w-3xl rounded-[30px] border border-white/10 bg-[#0b0b12] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.45)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-[#ff7bd8]">Generated Showcase Clip</p>
                <h3 className="mt-2 text-2xl font-semibold text-white">{selectedClip.title}</h3>
                <p className="mt-2 text-sm text-white/60">Source: {selectedClip.source}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedClip(null)}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm text-white/70 transition hover:bg-white/[0.08] hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-[0.72fr_1fr]">
              <div className={`aspect-[9/16] rounded-[24px] border border-white/10 bg-gradient-to-b ${selectedClip.gradient} p-3`}>
                <div className="flex h-full items-end rounded-[18px] border border-white/10 bg-black/20 p-3">
                  <div className="w-full rounded-2xl border border-white/10 bg-black/35 p-3 text-sm text-white/80 backdrop-blur">
                    {selectedClip.caption}
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-[#ff7bd8]/30 bg-[#ff7bd8]/10 px-3 py-1 text-xs font-semibold text-[#ffb1ea]">🔥 {selectedClip.score} AI Score</span>
                  <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${getPlatformBadge(selectedClip.platform)} ${getPlatformTone(selectedClip.platform)}`}>
                    {selectedClip.platform}
                  </span>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-white/60">{selectedClip.length}</span>
                </div>
                <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Generated with Animacut</p>
                  <p className="mt-3 text-sm leading-7 text-white/68">
                    This demo card represents a public long-form source transformed into a short-form candidate with AI scoring, title generation, caption-ready structure, and platform packaging.
                  </p>
                </div>
                <div className="rounded-[22px] border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Why it works</p>
                  <ul className="mt-3 space-y-2 text-sm text-white/68">
                    <li>• Strong hook detected in the opening seconds</li>
                    <li>• Clear source attribution for public demo content</li>
                    <li>• Platform-aware packaging for short-form distribution</li>
                    <li>• Fast preview of what a finished export can look like</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
