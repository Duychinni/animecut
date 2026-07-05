'use client';

import Image from 'next/image';
import { useState } from 'react';

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
      { src: '/demo/upload-demo-a.png', alt: 'Upload demo screen 1' },
      { src: '/demo/upload-demo-b.png', alt: 'Upload demo screen 2' },
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

export function DemoShowcase() {
  const [activeId, setActiveId] = useState(steps[0]?.id ?? 'upload');
  const active = steps.find((step) => step.id === activeId) ?? steps[0];

  return (
    <section className="mt-16 rounded-[28px] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-sm md:p-8">
      <div className="grid items-start gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.22em] text-[#ff7bd8]">Product demo</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-white md:text-4xl">See exactly how AnimaCut works.</h2>
          <p className="mt-4 max-w-xl text-sm leading-7 text-white/65 md:text-base">
            Walk through the product flow from upload to processing. When you send the results screenshot, I’ll plug that in too.
          </p>

          <div className="mt-6 space-y-3">
            {steps.map((step, index) => {
              const activeStep = step.id === active.id;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setActiveId(step.id)}
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
          <div className="flex gap-2">
            {steps.map((step) => {
              const activeStep = step.id === active.id;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setActiveId(step.id)}
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

          <div className="mt-4 overflow-hidden rounded-[24px] border border-white/10 bg-black/25 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
            <div className="relative overflow-hidden rounded-[18px] border border-white/10 bg-[#0a0a10]">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-xs text-white/45">
                <span>{active.title}</span>
                <span>{active.id === 'results' ? 'Results screenshot coming next' : 'Live product screenshot'}</span>
              </div>

              {active.images?.length ? (
                <div className="grid gap-3 bg-black p-3 sm:grid-cols-2">
                  {active.images.map((image) => (
                    <div key={image.src} className="relative overflow-hidden rounded-[16px] border border-white/10 bg-black">
                      <div className="relative aspect-[16/10]">
                        <Image src={image.src} alt={image.alt} fill className="object-cover" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : active.image ? (
                <div className="relative aspect-[16/10] bg-black">
                  <Image src={active.image} alt={active.imageAlt || active.title} fill className="object-cover" />
                </div>
              ) : (
                <div className={`relative aspect-[16/10] bg-gradient-to-br ${active.accent}`}>
                  <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(255,255,255,0.04),transparent)]" />
                  <div className="absolute left-6 top-6 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/80 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
                    Results demo panel
                  </div>
                  <div className="absolute left-6 right-6 top-24 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-white/60">
                    Drop your results screenshot here next and I’ll wire it in.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
