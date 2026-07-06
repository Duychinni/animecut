'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState } from 'react';

type DemoStep = {
  id: string;
  label: string;
  title: string;
  description: string;
  image?: string;
  imageAlt?: string;
  images?: { src: string; alt: string }[];
  accent: string;
};

const steps: DemoStep[] = [
  {
    id: 'upload',
    label: 'Upload',
    title: 'Paste a link or upload a source file',
    description: 'Start a project in seconds with a YouTube link or your own video.',
    images: [
      { src: '/demo/upload-demo-b.png', alt: 'Upload demo hero screen' },
      { src: '/demo/upload-demo-a.png', alt: 'Upload demo secondary screen' },
    ],
    accent: 'from-fuchsia-500/25 via-pink-500/15 to-transparent',
  },
  {
    id: 'processing',
    label: 'Processing',
    title: 'Watch AI find the strongest moments',
    description: 'Track progress while AnimaCut scans the transcript and builds top candidate clips.',
    image: '/demo/processing-demo.png',
    imageAlt: 'Processing demo screen',
    accent: 'from-violet-500/25 via-fuchsia-500/15 to-transparent',
  },
  {
    id: 'results',
    label: 'Results',
    title: 'Review reels that are ready to post',
    description: 'Open the best clips, compare scores, and download the strongest short-form cuts.',
    accent: 'from-amber-400/25 via-orange-400/15 to-transparent',
  },
];

function DemoResultsSlide() {
  return (
    <div className="relative aspect-[16/10] overflow-hidden bg-[#07070d]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_18%,rgba(255,133,214,0.18),transparent_24%),radial-gradient(circle_at_78%_22%,rgba(147,51,234,0.16),transparent_24%),radial-gradient(circle_at_56%_78%,rgba(255,176,76,0.12),transparent_22%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.03),transparent)]" />

      <div className="absolute left-6 top-6 right-6 flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 backdrop-blur-sm">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ffb347]">Top clips ready</p>
          <p className="mt-1 text-sm font-semibold text-white">Your highest scoring reels are ready to review</p>
        </div>
        <div className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-200">
          Exported
        </div>
      </div>

      <div className="absolute left-6 right-6 top-28 grid gap-3 sm:grid-cols-3">
        {[
          { title: 'Big reveal moment', score: 92, color: 'text-emerald-300' },
          { title: 'Unexpected reaction', score: 88, color: 'text-[#ffb347]' },
          { title: 'Strong opening hook', score: 84, color: 'text-fuchsia-300' },
        ].map((clip, index) => (
          <div
            key={clip.title}
            className="rounded-[22px] border border-white/10 bg-black/35 p-3 shadow-[0_18px_40px_rgba(0,0,0,0.22)] backdrop-blur-sm"
            style={{ transform: `translateY(${index * 8}px)` }}
          >
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#11121a]">
              <div className="aspect-[9/16] bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.01))]" />
              <div className="absolute inset-x-0 bottom-0 p-3">
                <div className="rounded-xl border border-white/10 bg-black/55 px-3 py-2 backdrop-blur-sm">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Clip preview</p>
                  <p className="mt-1 text-sm font-semibold text-white">{clip.title}</p>
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className={`text-lg font-black ${clip.color}`}>{clip.score}</span>
              <button className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/75">
                Download
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DemoUploadSlide({ images }: { images: { src: string; alt: string }[] }) {
  const primary = images[0];
  const secondary = images[1];

  return (
    <div className="grid gap-3 bg-black p-3 lg:grid-cols-[1.35fr_0.65fr]">
      <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
        <div className="relative aspect-[16/10]">
          <Image src={primary.src} alt={primary.alt} fill className="object-cover object-center" />
        </div>
      </div>

      {secondary ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#ff7bd8]">Step 1</p>
            <p className="mt-2 text-sm font-semibold text-white">Drop a link and hit Get Clips</p>
            <p className="mt-2 text-sm leading-6 text-white/60">The first screen should do most of the selling, so it now gets the bigger visual weight.</p>
          </div>

          <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[0_18px_40px_rgba(0,0,0,0.24)]">
            <div className="relative aspect-[10/10]">
              <Image src={secondary.src} alt={secondary.alt} fill className="object-cover object-center" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DemoShowcase() {
  const [activeIndex, setActiveIndex] = useState(0);
  const active = steps[activeIndex] ?? steps[0];

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % steps.length);
    }, 4500);

    return () => clearInterval(timer);
  }, []);

  const progressWidth = useMemo(() => `${((activeIndex + 1) / steps.length) * 100}%`, [activeIndex]);

  function goTo(index: number) {
    const safe = (index + steps.length) % steps.length;
    setActiveIndex(safe);
  }

  return (
    <section className="mt-16 rounded-[28px] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm md:p-8">
      <div className="grid items-start gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">Product demo</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white md:text-4xl">See exactly how AnimaCut works.</h2>
          <p className="mt-4 max-w-xl text-sm leading-7 text-white/65 md:text-base">
            A quick slide walkthrough of the flow from upload to results, so people instantly understand what happens next.
          </p>

          <div className="mt-6 space-y-3">
            {steps.map((step, index) => {
              const activeStep = index === activeIndex;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => goTo(index)}
                  className={`flex w-full items-start gap-4 rounded-2xl border px-4 py-4 text-left transition ${
                    activeStep
                      ? 'border-white/20 bg-white/[0.07]'
                      : 'border-white/10 bg-black/20 hover:border-white/15 hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="text-sm font-black tracking-[0.18em] text-white/35">{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <p className="text-sm font-semibold text-white">{step.title}</p>
                    <p className="mt-1 text-sm text-white/65">{step.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              {steps.map((step, index) => {
                const activeStep = index === activeIndex;
                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => goTo(index)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      activeStep
                        ? 'border-white/20 bg-white/[0.08] text-white'
                        : 'border-white/10 bg-black/20 text-white/65 hover:text-white'
                    }`}
                  >
                    {step.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => goTo(activeIndex - 1)}
                className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:text-white"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => goTo(activeIndex + 1)}
                className="rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:text-white"
              >
                Next
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-[24px] border border-white/10 bg-black/25 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
            <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-[#0a0a10]">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-xs text-white/45">
                <span>{active.title}</span>
                <span>Interactive walkthrough</span>
              </div>

              <div className="h-1 w-full bg-white/5">
                <div className="h-full bg-[linear-gradient(90deg,#ff7bd8,#c084fc,#ffb347)] transition-all duration-500" style={{ width: progressWidth }} />
              </div>

              {active.id === 'upload' && active.images?.length ? (
                <DemoUploadSlide images={active.images} />
              ) : active.image ? (
                <div className="relative aspect-[16/10] bg-black">
                  <Image src={active.image} alt={active.imageAlt || active.title} fill className="object-cover" />
                  <div className="absolute bottom-4 left-4 rounded-xl border border-white/10 bg-black/55 px-3 py-2 text-xs text-white/70 backdrop-blur-sm">
                    Live processing preview
                  </div>
                </div>
              ) : (
                <DemoResultsSlide />
              )}
            </div>

            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">{active.label}</p>
                <p className="mt-1 text-sm text-white/60">{active.description}</p>
              </div>

              <div className="flex items-center gap-2">
                {steps.map((step, index) => (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => goTo(index)}
                    aria-label={`Go to ${step.label} slide`}
                    className={`h-2.5 rounded-full transition-all ${index === activeIndex ? 'w-8 bg-white' : 'w-2.5 bg-white/25 hover:bg-white/45'}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
