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
    image: '/demo/results-demo.png',
    imageAlt: 'Results demo screen',
    accent: 'from-amber-400/25 via-orange-400/15 to-transparent',
  },
];

function DemoUploadSlide({ images }: { images: { src: string; alt: string }[] }) {
  const primary = images[0];

  return (
    <div className="bg-black p-3">
      <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
        <div className="relative aspect-[16/10]">
          <Image src={primary.src} alt={primary.alt} fill className="object-cover object-center" />
        </div>

        <div className="absolute right-4 top-4 max-w-[220px] rounded-2xl border border-white/10 bg-black/55 p-4 backdrop-blur-sm">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#ff7bd8]">Step 1</p>
          <p className="mt-2 text-sm font-semibold text-white">Drop a link and hit Get Clips</p>
          <p className="mt-2 text-sm leading-6 text-white/70">The upload screen now gets the full spotlight without that extra bottom-right box.</p>
        </div>
      </div>
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
                    {active.id === 'results' ? 'Live results preview' : 'Live processing preview'}
                  </div>
                </div>
              ) : null}
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
